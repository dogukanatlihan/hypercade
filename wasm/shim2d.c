// Box2D v3 -> WASM shim (w2_). Deliberately line-for-line comparable with
// shim3d.c (w3_) — same slot/handle scheme, same flat state buffer pattern,
// same event buffers. The 2D/3D API mirroring is part of the tech story.
//
// Handles are 32-bit ints: (generation << 16) | slot. A stale handle whose
// slot was reused fails the generation check instead of aliasing a live body.

#include "box2d/box2d.h"
#include "box2d/math_functions.h"

#include <emscripten/emscripten.h>
#include <math.h>
#include <stdint.h>
#include <string.h>

#define MAX_BODIES 2048
#define MAX_JOINTS 512
#define MAX_HITS 64
#define MAX_CONTACTS 256
#define MAX_SENSOR_EVENTS 256
#define MAX_SHAPES_PER_BODY 32

// Per-slot state layout (floats):
// [0-1] pos, [2] angle (radians), [3] awake, [4] valid, [5-6] linear vel, [7] angular vel
#define STATE_STRIDE 8

// Hit event layout (floats): px,py,pz(0), nx,ny,nz(0), speed, slotA, userA, slotB, userB, pad
// — identical stride to the 3D shim so the JS wrappers stay symmetric.
#define HIT_STRIDE 12
// Contact begin/end layout (floats): slotA, userA, slotB, userB
#define CONTACT_STRIDE 4
// Sensor begin/end layout (floats): sensorSlot, sensorUser, visitorSlot, visitorUser
#define SENSOR_STRIDE 4

static b2WorldId g_world;

static b2BodyId g_bodies[MAX_BODIES];
static uint16_t g_gen[MAX_BODIES];
static bool g_valid[MAX_BODIES];
static int g_userData[MAX_BODIES];
static int g_freeList[MAX_BODIES];
static int g_freeCount = 0;
static int g_highSlot = 0;

static b2JointId g_joints[MAX_JOINTS];
static uint16_t g_jointGen[MAX_JOINTS];
static bool g_jointValid[MAX_JOINTS];
static int g_jointType[MAX_JOINTS]; // 0 revolute, 1 prismatic, 2 distance, 4 mouse
static int g_jointFree[MAX_JOINTS];
static int g_jointFreeCount = 0;
static int g_jointHigh = 0;

static float g_states[MAX_BODIES * STATE_STRIDE];
static float g_hits[MAX_HITS * HIT_STRIDE];
static int g_hitCount = 0;
static float g_contactBegin[MAX_CONTACTS * CONTACT_STRIDE];
static int g_contactBeginCount = 0;
static float g_contactEnd[MAX_CONTACTS * CONTACT_STRIDE];
static int g_contactEndCount = 0;
static float g_sensorBegin[MAX_SENSOR_EVENTS * SENSOR_STRIDE];
static int g_sensorBeginCount = 0;
static float g_sensorEnd[MAX_SENSOR_EVENTS * SENSOR_STRIDE];
static int g_sensorEndCount = 0;
static float g_rayResult[8]; // px,py,0, nx,ny,0, fraction, slot(-1 = miss)

// ---- handle helpers ----

static int AllocSlot( void )
{
	if ( g_freeCount > 0 )
	{
		return g_freeList[--g_freeCount];
	}
	if ( g_highSlot >= MAX_BODIES )
	{
		return -1;
	}
	int slot = g_highSlot++;
	g_gen[slot] = 1;
	return slot;
}

static int Slot( int handle )
{
	int slot = handle & 0xFFFF;
	int gen = ( handle >> 16 ) & 0x7FFF;
	if ( slot < 0 || slot >= MAX_BODIES || !g_valid[slot] || g_gen[slot] != gen )
	{
		return -1;
	}
	return slot;
}

static int Handle( int slot )
{
	return ( (int)g_gen[slot] << 16 ) | slot;
}

static int JointSlot( int handle )
{
	int slot = handle & 0xFFFF;
	int gen = ( handle >> 16 ) & 0x7FFF;
	if ( slot < 0 || slot >= MAX_JOINTS || !g_jointValid[slot] || g_jointGen[slot] != gen )
	{
		return -1;
	}
	return slot;
}

static int SlotFromShape( b2ShapeId shapeId )
{
	if ( !b2Shape_IsValid( shapeId ) )
	{
		return -1;
	}
	b2BodyId body = b2Shape_GetBody( shapeId );
	return (int)(intptr_t)b2Body_GetUserData( body );
}

// ---- world ----

EMSCRIPTEN_KEEPALIVE
void w2_Init( float gx, float gy )
{
	if ( b2World_IsValid( g_world ) )
	{
		b2DestroyWorld( g_world );
	}

	b2WorldDef def = b2DefaultWorldDef();
	def.gravity = (b2Vec2){ gx, gy };
	g_world = b2CreateWorld( &def );

	memset( g_valid, 0, sizeof( g_valid ) );
	memset( g_states, 0, sizeof( g_states ) );
	memset( g_userData, 0, sizeof( g_userData ) );
	memset( g_jointValid, 0, sizeof( g_jointValid ) );
	g_freeCount = 0;
	g_highSlot = 0;
	g_jointFreeCount = 0;
	g_jointHigh = 0;
	g_hitCount = 0;
	g_contactBeginCount = 0;
	g_contactEndCount = 0;
	g_sensorBeginCount = 0;
	g_sensorEndCount = 0;
}

EMSCRIPTEN_KEEPALIVE
void w2_SetGravity( float gx, float gy )
{
	b2World_SetGravity( g_world, (b2Vec2){ gx, gy } );
}

EMSCRIPTEN_KEEPALIVE
void w2_SetHitEventThreshold( float speed )
{
	b2World_SetHitEventThreshold( g_world, speed );
}

// ---- bodies ----

// type: 0 static, 1 kinematic, 2 dynamic. Returns generation-checked handle, -1 on overflow.
EMSCRIPTEN_KEEPALIVE
int w2_CreateBody( int type, float px, float py, float angle, float linearDamping, float angularDamping,
				   float gravityScale, int enableSleep, int isBullet, int fixedRotation )
{
	int slot = AllocSlot();
	if ( slot < 0 )
	{
		return -1;
	}

	b2BodyDef def = b2DefaultBodyDef();
	def.type = (b2BodyType)type;
	def.position = (b2Vec2){ px, py };
	def.rotation = b2MakeRot( angle );
	def.linearDamping = linearDamping;
	def.angularDamping = angularDamping;
	def.gravityScale = gravityScale;
	def.enableSleep = enableSleep != 0;
	def.isBullet = isBullet != 0;
	def.fixedRotation = fixedRotation != 0;
	def.userData = (void*)(intptr_t)slot;

	g_bodies[slot] = b2CreateBody( g_world, &def );
	g_valid[slot] = true;
	g_userData[slot] = 0;
	return Handle( slot );
}

// flags: 1 sensor, 2 contact events, 4 hit events. Sensor events always on
// so sensors can observe any body without pre-planning (mirrors w3_).
static b2ShapeDef MakeShapeDef( float density, float friction, float restitution, int flags )
{
	b2ShapeDef def = b2DefaultShapeDef();
	def.density = density;
	def.material.friction = friction;
	def.material.restitution = restitution;
	def.isSensor = ( flags & 1 ) != 0;
	def.enableSensorEvents = true;
	def.enableContactEvents = ( flags & 2 ) != 0;
	def.enableHitEvents = ( flags & 4 ) != 0;
	return def;
}

EMSCRIPTEN_KEEPALIVE
void w2_AddBoxShape( int handle, float hx, float hy, float density, float friction, float restitution, int flags )
{
	int slot = Slot( handle );
	if ( slot < 0 )
	{
		return;
	}
	b2Polygon box = b2MakeBox( hx, hy );
	b2ShapeDef def = MakeShapeDef( density, friction, restitution, flags );
	b2CreatePolygonShape( g_bodies[slot], &def, &box );
}

// Box shape at a local offset/rotation — compound bodies (mirrors w3_AddBoxShapeOffset).
EMSCRIPTEN_KEEPALIVE
void w2_AddBoxShapeOffset( int handle, float hx, float hy, float ox, float oy, float angle, float density,
						   float friction, float restitution, int flags )
{
	int slot = Slot( handle );
	if ( slot < 0 )
	{
		return;
	}
	b2Polygon box = b2MakeOffsetBox( hx, hy, (b2Vec2){ ox, oy }, b2MakeRot( angle ) );
	b2ShapeDef def = MakeShapeDef( density, friction, restitution, flags );
	b2CreatePolygonShape( g_bodies[slot], &def, &box );
}

EMSCRIPTEN_KEEPALIVE
void w2_AddCircleShape( int handle, float cx, float cy, float radius, float density, float friction, float restitution,
						int flags )
{
	int slot = Slot( handle );
	if ( slot < 0 )
	{
		return;
	}
	b2Circle circle = { { cx, cy }, radius };
	b2ShapeDef def = MakeShapeDef( density, friction, restitution, flags );
	b2CreateCircleShape( g_bodies[slot], &def, &circle );
}

EMSCRIPTEN_KEEPALIVE
void w2_AddCapsuleShape( int handle, float x1, float y1, float x2, float y2, float radius, float density,
						 float friction, float restitution, int flags )
{
	int slot = Slot( handle );
	if ( slot < 0 )
	{
		return;
	}
	b2Capsule capsule = { { x1, y1 }, { x2, y2 }, radius };
	b2ShapeDef def = MakeShapeDef( density, friction, restitution, flags );
	b2CreateCapsuleShape( g_bodies[slot], &def, &capsule );
}

// One-sided-thin static geometry (level walls / grounds).
EMSCRIPTEN_KEEPALIVE
void w2_AddSegmentShape( int handle, float x1, float y1, float x2, float y2, float friction, float restitution, int flags )
{
	int slot = Slot( handle );
	if ( slot < 0 )
	{
		return;
	}
	b2Segment segment = { { x1, y1 }, { x2, y2 } };
	b2ShapeDef def = MakeShapeDef( 1.0f, friction, restitution, flags );
	b2CreateSegmentShape( g_bodies[slot], &def, &segment );
}

EMSCRIPTEN_KEEPALIVE
void w2_DestroyBody( int handle )
{
	int slot = Slot( handle );
	if ( slot < 0 )
	{
		return;
	}
	b2DestroyBody( g_bodies[slot] );
	g_valid[slot] = false;
	g_gen[slot] = (uint16_t)( ( g_gen[slot] + 1 ) & 0x7FFF );
	if ( g_gen[slot] == 0 )
	{
		g_gen[slot] = 1;
	}
	g_states[slot * STATE_STRIDE + 4] = 0.0f;
	g_freeList[g_freeCount++] = slot;
}

EMSCRIPTEN_KEEPALIVE
int w2_IsValid( int handle )
{
	return Slot( handle ) >= 0 ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
void w2_SetUserData( int handle, int value )
{
	int slot = Slot( handle );
	if ( slot >= 0 )
	{
		g_userData[slot] = value;
	}
}

EMSCRIPTEN_KEEPALIVE
int w2_GetUserData( int handle )
{
	int slot = Slot( handle );
	return slot >= 0 ? g_userData[slot] : 0;
}

EMSCRIPTEN_KEEPALIVE
void w2_SetTransform( int handle, float px, float py, float angle )
{
	int slot = Slot( handle );
	if ( slot >= 0 )
	{
		b2Body_SetTransform( g_bodies[slot], (b2Vec2){ px, py }, b2MakeRot( angle ) );
	}
}

// Kinematic body motion: engine computes velocity to arrive at target next step.
EMSCRIPTEN_KEEPALIVE
void w2_SetTargetTransform( int handle, float px, float py, float angle, float dt )
{
	int slot = Slot( handle );
	if ( slot >= 0 )
	{
		b2Transform target = { { px, py }, b2MakeRot( angle ) };
		b2Body_SetTargetTransform( g_bodies[slot], target, dt );
	}
}

EMSCRIPTEN_KEEPALIVE
void w2_SetLinearVelocity( int handle, float vx, float vy )
{
	int slot = Slot( handle );
	if ( slot >= 0 )
	{
		b2Body_SetLinearVelocity( g_bodies[slot], (b2Vec2){ vx, vy } );
	}
}

EMSCRIPTEN_KEEPALIVE
void w2_SetAngularVelocity( int handle, float w )
{
	int slot = Slot( handle );
	if ( slot >= 0 )
	{
		b2Body_SetAngularVelocity( g_bodies[slot], w );
	}
}

EMSCRIPTEN_KEEPALIVE
void w2_ApplyImpulse( int handle, float ix, float iy )
{
	int slot = Slot( handle );
	if ( slot >= 0 )
	{
		b2Body_ApplyLinearImpulseToCenter( g_bodies[slot], (b2Vec2){ ix, iy }, true );
	}
}

EMSCRIPTEN_KEEPALIVE
void w2_ApplyImpulseAt( int handle, float ix, float iy, float px, float py )
{
	int slot = Slot( handle );
	if ( slot >= 0 )
	{
		b2Body_ApplyLinearImpulse( g_bodies[slot], (b2Vec2){ ix, iy }, (b2Vec2){ px, py }, true );
	}
}

// Per-step force (force fields: rope air jets, plinko magnets, draw wind).
EMSCRIPTEN_KEEPALIVE
void w2_ApplyForce( int handle, float fx, float fy )
{
	int slot = Slot( handle );
	if ( slot >= 0 )
	{
		b2Body_ApplyForceToCenter( g_bodies[slot], (b2Vec2){ fx, fy }, true );
	}
}

EMSCRIPTEN_KEEPALIVE
void w2_ApplyTorque( int handle, float torque )
{
	int slot = Slot( handle );
	if ( slot >= 0 )
	{
		b2Body_ApplyTorque( g_bodies[slot], torque, true );
	}
}

EMSCRIPTEN_KEEPALIVE
void w2_SetGravityScale( int handle, float scale )
{
	int slot = Slot( handle );
	if ( slot >= 0 )
	{
		b2Body_SetGravityScale( g_bodies[slot], scale );
	}
}

EMSCRIPTEN_KEEPALIVE
void w2_SetAwake( int handle, int awake )
{
	int slot = Slot( handle );
	if ( slot >= 0 )
	{
		b2Body_SetAwake( g_bodies[slot], awake != 0 );
	}
}

EMSCRIPTEN_KEEPALIVE
void w2_SetEnabled( int handle, int enabled )
{
	int slot = Slot( handle );
	if ( slot < 0 )
	{
		return;
	}
	if ( enabled )
	{
		b2Body_Enable( g_bodies[slot] );
	}
	else
	{
		b2Body_Disable( g_bodies[slot] );
	}
}

EMSCRIPTEN_KEEPALIVE
void w2_SetBodyType( int handle, int type )
{
	int slot = Slot( handle );
	if ( slot >= 0 )
	{
		b2Body_SetType( g_bodies[slot], (b2BodyType)type );
	}
}

// Collision filter on every shape of the body.
EMSCRIPTEN_KEEPALIVE
void w2_SetFilter( int handle, int categoryBits, int maskBits, int groupIndex )
{
	int slot = Slot( handle );
	if ( slot < 0 )
	{
		return;
	}
	b2ShapeId shapes[MAX_SHAPES_PER_BODY];
	int count = b2Body_GetShapes( g_bodies[slot], shapes, MAX_SHAPES_PER_BODY );
	b2Filter filter = { (uint64_t)(uint32_t)categoryBits, (uint64_t)(uint32_t)maskBits, groupIndex };
	for ( int i = 0; i < count; ++i )
	{
		b2Shape_SetFilter( shapes[i], filter );
	}
}

EMSCRIPTEN_KEEPALIVE
float w2_GetMass( int handle )
{
	int slot = Slot( handle );
	return slot >= 0 ? b2Body_GetMass( g_bodies[slot] ) : 0.0f;
}

// ---- joints ----

static int StoreJoint( b2JointId id, int type )
{
	int slot;
	if ( g_jointFreeCount > 0 )
	{
		slot = g_jointFree[--g_jointFreeCount];
	}
	else if ( g_jointHigh < MAX_JOINTS )
	{
		slot = g_jointHigh++;
		g_jointGen[slot] = 1;
	}
	else
	{
		b2DestroyJoint( id );
		return -1;
	}
	g_joints[slot] = id;
	g_jointValid[slot] = true;
	g_jointType[slot] = type;
	return ( (int)g_jointGen[slot] << 16 ) | slot;
}

// Hinge through world anchor.
EMSCRIPTEN_KEEPALIVE
int w2_CreateRevoluteJoint( int handleA, int handleB, float px, float py, float lower, float upper, int enableLimit,
							float motorSpeed, float maxMotorTorque, int enableMotor, int collideConnected )
{
	int a = Slot( handleA );
	int b = Slot( handleB );
	if ( a < 0 || b < 0 )
	{
		return -1;
	}
	b2Vec2 anchor = { px, py };
	b2RevoluteJointDef def = b2DefaultRevoluteJointDef();
	def.bodyIdA = g_bodies[a];
	def.bodyIdB = g_bodies[b];
	def.localAnchorA = b2Body_GetLocalPoint( g_bodies[a], anchor );
	def.localAnchorB = b2Body_GetLocalPoint( g_bodies[b], anchor );
	def.collideConnected = collideConnected != 0;
	def.enableLimit = enableLimit != 0;
	def.lowerAngle = lower;
	def.upperAngle = upper;
	def.enableMotor = enableMotor != 0;
	def.motorSpeed = motorSpeed;
	def.maxMotorTorque = maxMotorTorque;
	return StoreJoint( b2CreateRevoluteJoint( g_world, &def ), 0 );
}

// Slider along world axis (ax,ay) through world anchor.
EMSCRIPTEN_KEEPALIVE
int w2_CreatePrismaticJoint( int handleA, int handleB, float px, float py, float ax, float ay, float lower, float upper,
							 int enableLimit, float motorSpeed, float maxMotorForce, int enableMotor )
{
	int a = Slot( handleA );
	int b = Slot( handleB );
	if ( a < 0 || b < 0 )
	{
		return -1;
	}
	b2Vec2 anchor = { px, py };
	b2PrismaticJointDef def = b2DefaultPrismaticJointDef();
	def.bodyIdA = g_bodies[a];
	def.bodyIdB = g_bodies[b];
	def.localAnchorA = b2Body_GetLocalPoint( g_bodies[a], anchor );
	def.localAnchorB = b2Body_GetLocalPoint( g_bodies[b], anchor );
	def.localAxisA = b2Body_GetLocalVector( g_bodies[a], b2Normalize( (b2Vec2){ ax, ay } ) );
	def.enableLimit = enableLimit != 0;
	def.lowerTranslation = lower;
	def.upperTranslation = upper;
	def.enableMotor = enableMotor != 0;
	def.motorSpeed = motorSpeed;
	def.maxMotorForce = maxMotorForce;
	return StoreJoint( b2CreatePrismaticJoint( g_world, &def ), 1 );
}

EMSCRIPTEN_KEEPALIVE
int w2_CreateDistanceJoint( int handleA, int handleB, float ax, float ay, float bx, float by, float length,
							float minLength, float maxLength, int enableLimit, float hertz, float dampingRatio,
							int enableSpring, int collideConnected )
{
	int a = Slot( handleA );
	int b = Slot( handleB );
	if ( a < 0 || b < 0 )
	{
		return -1;
	}
	b2DistanceJointDef def = b2DefaultDistanceJointDef();
	def.bodyIdA = g_bodies[a];
	def.bodyIdB = g_bodies[b];
	def.localAnchorA = b2Body_GetLocalPoint( g_bodies[a], (b2Vec2){ ax, ay } );
	def.localAnchorB = b2Body_GetLocalPoint( g_bodies[b], (b2Vec2){ bx, by } );
	def.collideConnected = collideConnected != 0;
	def.length = length;
	def.enableSpring = enableSpring != 0;
	def.hertz = hertz;
	def.dampingRatio = dampingRatio;
	def.enableLimit = enableLimit != 0;
	def.minLength = minLength;
	def.maxLength = maxLength;
	return StoreJoint( b2CreateDistanceJoint( g_world, &def ), 2 );
}

// Soft target-follow joint for drag interactions (2D only).
EMSCRIPTEN_KEEPALIVE
int w2_CreateMouseJoint( int handleA, int handleB, float tx, float ty, float hertz, float dampingRatio, float maxForce )
{
	int a = Slot( handleA );
	int b = Slot( handleB );
	if ( a < 0 || b < 0 )
	{
		return -1;
	}
	b2MouseJointDef def = b2DefaultMouseJointDef();
	def.bodyIdA = g_bodies[a];
	def.bodyIdB = g_bodies[b];
	def.target = (b2Vec2){ tx, ty };
	def.hertz = hertz;
	def.dampingRatio = dampingRatio;
	def.maxForce = maxForce;
	return StoreJoint( b2CreateMouseJoint( g_world, &def ), 4 );
}

EMSCRIPTEN_KEEPALIVE
void w2_MouseJoint_SetTarget( int jointHandle, float tx, float ty )
{
	int slot = JointSlot( jointHandle );
	if ( slot >= 0 && g_jointType[slot] == 4 )
	{
		b2MouseJoint_SetTarget( g_joints[slot], (b2Vec2){ tx, ty } );
		// dragged bodies must not doze mid-drag
		b2Joint_WakeBodies( g_joints[slot] );
	}
}

EMSCRIPTEN_KEEPALIVE
void w2_DestroyJoint( int jointHandle )
{
	int slot = JointSlot( jointHandle );
	if ( slot < 0 )
	{
		return;
	}
	b2DestroyJoint( g_joints[slot] );
	g_jointValid[slot] = false;
	g_jointGen[slot] = (uint16_t)( ( g_jointGen[slot] + 1 ) & 0x7FFF );
	if ( g_jointGen[slot] == 0 )
	{
		g_jointGen[slot] = 1;
	}
	g_jointFree[g_jointFreeCount++] = slot;
}

EMSCRIPTEN_KEEPALIVE
void w2_SetMotorSpeed( int jointHandle, float speed )
{
	int slot = JointSlot( jointHandle );
	if ( slot < 0 )
	{
		return;
	}
	if ( g_jointType[slot] == 0 )
	{
		b2RevoluteJoint_SetMotorSpeed( g_joints[slot], speed );
	}
	else if ( g_jointType[slot] == 1 )
	{
		b2PrismaticJoint_SetMotorSpeed( g_joints[slot], speed );
	}
}

// ---- queries ----

// Closest-hit raycast. Returns 1 on hit; result in w2_GetRayResultPtr buffer.
EMSCRIPTEN_KEEPALIVE
int w2_CastRayClosest( float ox, float oy, float tx, float ty, int categoryBits, int maskBits )
{
	b2QueryFilter filter = b2DefaultQueryFilter();
	filter.categoryBits = (uint64_t)(uint32_t)categoryBits;
	filter.maskBits = (uint64_t)(uint32_t)maskBits;
	b2RayResult result = b2World_CastRayClosest( g_world, (b2Vec2){ ox, oy }, (b2Vec2){ tx, ty }, filter );
	if ( !result.hit )
	{
		g_rayResult[7] = -1.0f;
		return 0;
	}
	g_rayResult[0] = result.point.x;
	g_rayResult[1] = result.point.y;
	g_rayResult[2] = 0.0f;
	g_rayResult[3] = result.normal.x;
	g_rayResult[4] = result.normal.y;
	g_rayResult[5] = 0.0f;
	g_rayResult[6] = result.fraction;
	g_rayResult[7] = (float)SlotFromShape( result.shapeId );
	return 1;
}

// ---- step & event collection ----

EMSCRIPTEN_KEEPALIVE
void w2_Step( float dt, int subStepCount )
{
	b2World_Step( g_world, dt, subStepCount );

	for ( int i = 0; i < g_highSlot; ++i )
	{
		float* s = g_states + i * STATE_STRIDE;
		if ( !g_valid[i] )
		{
			s[4] = 0.0f;
			continue;
		}
		b2Transform xf = b2Body_GetTransform( g_bodies[i] );
		b2Vec2 v = b2Body_GetLinearVelocity( g_bodies[i] );
		float w = b2Body_GetAngularVelocity( g_bodies[i] );
		s[0] = xf.p.x;
		s[1] = xf.p.y;
		s[2] = atan2f( xf.q.s, xf.q.c );
		s[3] = b2Body_IsAwake( g_bodies[i] ) ? 1.0f : 0.0f;
		s[4] = 1.0f;
		s[5] = v.x;
		s[6] = v.y;
		s[7] = w;
	}

	b2ContactEvents contacts = b2World_GetContactEvents( g_world );

	int hitCount = contacts.hitCount < MAX_HITS ? contacts.hitCount : MAX_HITS;
	g_hitCount = hitCount;
	for ( int i = 0; i < hitCount; ++i )
	{
		const b2ContactHitEvent* hit = contacts.hitEvents + i;
		float* h = g_hits + i * HIT_STRIDE;
		int slotA = SlotFromShape( hit->shapeIdA );
		int slotB = SlotFromShape( hit->shapeIdB );
		h[0] = hit->point.x;
		h[1] = hit->point.y;
		h[2] = 0.0f;
		h[3] = hit->normal.x;
		h[4] = hit->normal.y;
		h[5] = 0.0f;
		h[6] = hit->approachSpeed;
		h[7] = (float)slotA;
		h[8] = slotA >= 0 ? (float)g_userData[slotA] : 0.0f;
		h[9] = (float)slotB;
		h[10] = slotB >= 0 ? (float)g_userData[slotB] : 0.0f;
		h[11] = 0.0f;
	}

	int beginCount = contacts.beginCount < MAX_CONTACTS ? contacts.beginCount : MAX_CONTACTS;
	g_contactBeginCount = beginCount;
	for ( int i = 0; i < beginCount; ++i )
	{
		const b2ContactBeginTouchEvent* ev = contacts.beginEvents + i;
		float* c = g_contactBegin + i * CONTACT_STRIDE;
		int slotA = SlotFromShape( ev->shapeIdA );
		int slotB = SlotFromShape( ev->shapeIdB );
		c[0] = (float)slotA;
		c[1] = slotA >= 0 ? (float)g_userData[slotA] : 0.0f;
		c[2] = (float)slotB;
		c[3] = slotB >= 0 ? (float)g_userData[slotB] : 0.0f;
	}

	int endCount = contacts.endCount < MAX_CONTACTS ? contacts.endCount : MAX_CONTACTS;
	g_contactEndCount = endCount;
	for ( int i = 0; i < endCount; ++i )
	{
		const b2ContactEndTouchEvent* ev = contacts.endEvents + i;
		float* c = g_contactEnd + i * CONTACT_STRIDE;
		int slotA = SlotFromShape( ev->shapeIdA );
		int slotB = SlotFromShape( ev->shapeIdB );
		c[0] = (float)slotA;
		c[1] = slotA >= 0 ? (float)g_userData[slotA] : 0.0f;
		c[2] = (float)slotB;
		c[3] = slotB >= 0 ? (float)g_userData[slotB] : 0.0f;
	}

	b2SensorEvents sensors = b2World_GetSensorEvents( g_world );

	int sBegin = sensors.beginCount < MAX_SENSOR_EVENTS ? sensors.beginCount : MAX_SENSOR_EVENTS;
	g_sensorBeginCount = sBegin;
	for ( int i = 0; i < sBegin; ++i )
	{
		const b2SensorBeginTouchEvent* ev = sensors.beginEvents + i;
		float* s = g_sensorBegin + i * SENSOR_STRIDE;
		int sensorSlot = SlotFromShape( ev->sensorShapeId );
		int visitorSlot = SlotFromShape( ev->visitorShapeId );
		s[0] = (float)sensorSlot;
		s[1] = sensorSlot >= 0 ? (float)g_userData[sensorSlot] : 0.0f;
		s[2] = (float)visitorSlot;
		s[3] = visitorSlot >= 0 ? (float)g_userData[visitorSlot] : 0.0f;
	}

	int sEnd = sensors.endCount < MAX_SENSOR_EVENTS ? sensors.endCount : MAX_SENSOR_EVENTS;
	g_sensorEndCount = sEnd;
	for ( int i = 0; i < sEnd; ++i )
	{
		const b2SensorEndTouchEvent* ev = sensors.endEvents + i;
		float* s = g_sensorEnd + i * SENSOR_STRIDE;
		int sensorSlot = SlotFromShape( ev->sensorShapeId );
		int visitorSlot = SlotFromShape( ev->visitorShapeId );
		s[0] = (float)sensorSlot;
		s[1] = sensorSlot >= 0 ? (float)g_userData[sensorSlot] : 0.0f;
		s[2] = (float)visitorSlot;
		s[3] = visitorSlot >= 0 ? (float)g_userData[visitorSlot] : 0.0f;
	}
}

// ---- buffer access ----

EMSCRIPTEN_KEEPALIVE
float* w2_GetStatesPtr( void )
{
	return g_states;
}

EMSCRIPTEN_KEEPALIVE
int w2_GetStateStride( void )
{
	return STATE_STRIDE;
}

EMSCRIPTEN_KEEPALIVE
int w2_GetMaxBodies( void )
{
	return MAX_BODIES;
}

EMSCRIPTEN_KEEPALIVE
float* w2_GetHitsPtr( void )
{
	return g_hits;
}

EMSCRIPTEN_KEEPALIVE
int w2_GetHitCount( void )
{
	return g_hitCount;
}

EMSCRIPTEN_KEEPALIVE
float* w2_GetContactBeginPtr( void )
{
	return g_contactBegin;
}

EMSCRIPTEN_KEEPALIVE
int w2_GetContactBeginCount( void )
{
	return g_contactBeginCount;
}

EMSCRIPTEN_KEEPALIVE
float* w2_GetContactEndPtr( void )
{
	return g_contactEnd;
}

EMSCRIPTEN_KEEPALIVE
int w2_GetContactEndCount( void )
{
	return g_contactEndCount;
}

EMSCRIPTEN_KEEPALIVE
float* w2_GetSensorBeginPtr( void )
{
	return g_sensorBegin;
}

EMSCRIPTEN_KEEPALIVE
int w2_GetSensorBeginCount( void )
{
	return g_sensorBeginCount;
}

EMSCRIPTEN_KEEPALIVE
float* w2_GetSensorEndPtr( void )
{
	return g_sensorEnd;
}

EMSCRIPTEN_KEEPALIVE
int w2_GetSensorEndCount( void )
{
	return g_sensorEndCount;
}

EMSCRIPTEN_KEEPALIVE
float* w2_GetRayResultPtr( void )
{
	return g_rayResult;
}
