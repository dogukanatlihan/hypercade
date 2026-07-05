// Box3D -> WASM shim (w3_). HYPERCADE extended surface.
// Same architecture as the BOXSTACK reference shim, extended per TECH-BRIEF §3:
// spheres, capsules, compound offsets, kinematic targets, filters, raycast,
// joints (revolute/prismatic/distance/spherical) with motors, sensor events,
// contact events, impact-force hit events, body user-data, sleep/wake,
// body type swap, and generation-checked slot handles.
//
// Handles are 32-bit ints: (generation << 16) | slot. A stale handle whose
// slot was reused fails the generation check instead of aliasing a live body.
// Per-frame state is written into a flat float buffer read directly from WASM
// memory by JS (one w3_Step call per frame, zero per-body FFI).

#include "box3d/box3d.h"
#include "box3d/math_functions.h"

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
// [0-2] pos, [3-6] quat (x,y,z,s), [7] awake, [8] valid, [9-11] linear vel, [12-14] angular vel, [15] reserved
#define STATE_STRIDE 16

// Hit event layout (floats): px,py,pz, nx,ny,nz, speed, slotA, userA, slotB, userB, pad
#define HIT_STRIDE 12
// Contact begin/end layout (floats): slotA, userA, slotB, userB
#define CONTACT_STRIDE 4
// Sensor begin/end layout (floats): sensorSlot, sensorUser, visitorSlot, visitorUser
#define SENSOR_STRIDE 4

static b3WorldId g_world;

static b3BodyId g_bodies[MAX_BODIES];
static uint16_t g_gen[MAX_BODIES];
static bool g_valid[MAX_BODIES];
static int g_userData[MAX_BODIES];
static int g_freeList[MAX_BODIES];
static int g_freeCount = 0;
static int g_highSlot = 0;

static b3JointId g_joints[MAX_JOINTS];
static uint16_t g_jointGen[MAX_JOINTS];
static bool g_jointValid[MAX_JOINTS];
static int g_jointType[MAX_JOINTS]; // 0 revolute, 1 prismatic, 2 distance, 3 spherical
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
static float g_rayResult[8]; // px,py,pz, nx,ny,nz, fraction, slot(-1 = miss)

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

// Body slot from a shape id via the body's userData (set at creation).
// Returns -1 for destroyed/invalid shapes so JS can skip the event.
static int SlotFromShape( b3ShapeId shapeId )
{
	if ( !b3Shape_IsValid( shapeId ) )
	{
		return -1;
	}
	b3BodyId body = b3Shape_GetBody( shapeId );
	return (int)(intptr_t)b3Body_GetUserData( body );
}

// Quaternion rotating unit vector `from` onto unit vector `to` (half-way method).
static b3Quat QuatFromTo( b3Vec3 from, b3Vec3 to )
{
	float d = from.x * to.x + from.y * to.y + from.z * to.z;
	if ( d > 0.999999f )
	{
		return b3Quat_identity;
	}
	if ( d < -0.999999f )
	{
		// opposite: rotate 180° about any axis perpendicular to `from`
		b3Vec3 axis = fabsf( from.x ) < 0.9f ? (b3Vec3){ 1.0f, 0.0f, 0.0f } : (b3Vec3){ 0.0f, 1.0f, 0.0f };
		b3Vec3 c = { from.y * axis.z - from.z * axis.y, from.z * axis.x - from.x * axis.z, from.x * axis.y - from.y * axis.x };
		float len = sqrtf( c.x * c.x + c.y * c.y + c.z * c.z );
		return (b3Quat){ { c.x / len, c.y / len, c.z / len }, 0.0f };
	}
	b3Vec3 c = { from.y * to.z - from.z * to.y, from.z * to.x - from.x * to.z, from.x * to.y - from.y * to.x };
	b3Quat q = { { c.x, c.y, c.z }, 1.0f + d };
	float len = sqrtf( q.v.x * q.v.x + q.v.y * q.v.y + q.v.z * q.v.z + q.s * q.s );
	return (b3Quat){ { q.v.x / len, q.v.y / len, q.v.z / len }, q.s / len };
}

// Joint local frame on a body from a world anchor and a world frame rotation.
static b3Transform LocalFrame( b3BodyId body, b3Pos anchor, b3Quat worldRot )
{
	b3WorldTransform xf = b3Body_GetTransform( body );
	b3Transform frame;
	frame.p = b3Body_GetLocalPoint( body, anchor );
	frame.q = b3InvMulQuat( xf.q, worldRot );
	return frame;
}

// ---- world ----

EMSCRIPTEN_KEEPALIVE
void w3_Init( float gx, float gy, float gz )
{
	if ( b3World_IsValid( g_world ) )
	{
		b3DestroyWorld( g_world );
	}

	b3WorldDef def = b3DefaultWorldDef();
	def.gravity = (b3Vec3){ gx, gy, gz };
	g_world = b3CreateWorld( &def );

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
void w3_SetGravity( float gx, float gy, float gz )
{
	b3World_SetGravity( g_world, (b3Vec3){ gx, gy, gz } );
}

EMSCRIPTEN_KEEPALIVE
void w3_SetHitEventThreshold( float speed )
{
	b3World_SetHitEventThreshold( g_world, speed );
}

// ---- bodies ----

// type: 0 static, 1 kinematic, 2 dynamic. Returns generation-checked handle, -1 on overflow.
EMSCRIPTEN_KEEPALIVE
int w3_CreateBody( int type, float px, float py, float pz, float qx, float qy, float qz, float qs, float linearDamping,
				   float angularDamping, float gravityScale, int enableSleep, int isBullet )
{
	int slot = AllocSlot();
	if ( slot < 0 )
	{
		return -1;
	}

	b3BodyDef def = b3DefaultBodyDef();
	def.type = (b3BodyType)type;
	def.position = (b3Pos){ px, py, pz };
	def.rotation = (b3Quat){ { qx, qy, qz }, qs };
	def.linearDamping = linearDamping;
	def.angularDamping = angularDamping;
	def.gravityScale = gravityScale;
	def.enableSleep = enableSleep != 0;
	def.isBullet = isBullet != 0;
	def.userData = (void*)(intptr_t)slot;

	g_bodies[slot] = b3CreateBody( g_world, &def );
	g_valid[slot] = true;
	g_userData[slot] = 0;
	return Handle( slot );
}

// flags: 1 sensor, 2 contact events, 4 hit events. Sensor events are always
// enabled on every shape so sensors can observe any body without pre-planning.
static b3ShapeDef MakeShapeDef( float density, float friction, float restitution, int flags )
{
	b3ShapeDef def = b3DefaultShapeDef();
	def.density = density;
	def.baseMaterial.friction = friction;
	def.baseMaterial.restitution = restitution;
	def.isSensor = ( flags & 1 ) != 0;
	def.enableSensorEvents = true;
	def.enableContactEvents = ( flags & 2 ) != 0;
	def.enableHitEvents = ( flags & 4 ) != 0;
	return def;
}

EMSCRIPTEN_KEEPALIVE
void w3_AddBoxShape( int handle, float hx, float hy, float hz, float density, float friction, float restitution, int flags )
{
	int slot = Slot( handle );
	if ( slot < 0 )
	{
		return;
	}
	b3BoxHull box = b3MakeBoxHull( hx, hy, hz );
	b3ShapeDef def = MakeShapeDef( density, friction, restitution, flags );
	b3CreateHullShape( g_bodies[slot], &def, &box.base );
}

// Box shape at a local offset/rotation — compound bodies (helix layers, hole ring).
EMSCRIPTEN_KEEPALIVE
void w3_AddBoxShapeOffset( int handle, float hx, float hy, float hz, float ox, float oy, float oz, float qx, float qy,
						   float qz, float qs, float density, float friction, float restitution, int flags )
{
	int slot = Slot( handle );
	if ( slot < 0 )
	{
		return;
	}
	b3BoxHull box = b3MakeBoxHull( hx, hy, hz );
	b3ShapeDef def = MakeShapeDef( density, friction, restitution, flags );
	b3Transform xf = { { ox, oy, oz }, { { qx, qy, qz }, qs } };
	b3CreateTransformedHullShape( g_bodies[slot], &def, &box.base, xf, (b3Vec3){ 1.0f, 1.0f, 1.0f } );
}

EMSCRIPTEN_KEEPALIVE
void w3_AddSphereShape( int handle, float cx, float cy, float cz, float radius, float density, float friction,
						float restitution, int flags )
{
	int slot = Slot( handle );
	if ( slot < 0 )
	{
		return;
	}
	b3Sphere sphere = { { cx, cy, cz }, radius };
	b3ShapeDef def = MakeShapeDef( density, friction, restitution, flags );
	b3CreateSphereShape( g_bodies[slot], &def, &sphere );
}

EMSCRIPTEN_KEEPALIVE
void w3_AddCapsuleShape( int handle, float x1, float y1, float z1, float x2, float y2, float z2, float radius,
						 float density, float friction, float restitution, int flags )
{
	int slot = Slot( handle );
	if ( slot < 0 )
	{
		return;
	}
	b3Capsule capsule = { { x1, y1, z1 }, { x2, y2, z2 }, radius };
	b3ShapeDef def = MakeShapeDef( density, friction, restitution, flags );
	b3CreateCapsuleShape( g_bodies[slot], &def, &capsule );
}

EMSCRIPTEN_KEEPALIVE
void w3_DestroyBody( int handle )
{
	int slot = Slot( handle );
	if ( slot < 0 )
	{
		return;
	}
	b3DestroyBody( g_bodies[slot] );
	g_valid[slot] = false;
	g_gen[slot] = (uint16_t)( ( g_gen[slot] + 1 ) & 0x7FFF );
	if ( g_gen[slot] == 0 )
	{
		g_gen[slot] = 1;
	}
	g_states[slot * STATE_STRIDE + 8] = 0.0f;
	g_freeList[g_freeCount++] = slot;
}

EMSCRIPTEN_KEEPALIVE
int w3_IsValid( int handle )
{
	return Slot( handle ) >= 0 ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
void w3_SetUserData( int handle, int value )
{
	int slot = Slot( handle );
	if ( slot >= 0 )
	{
		g_userData[slot] = value;
	}
}

EMSCRIPTEN_KEEPALIVE
int w3_GetUserData( int handle )
{
	int slot = Slot( handle );
	return slot >= 0 ? g_userData[slot] : 0;
}

EMSCRIPTEN_KEEPALIVE
void w3_SetTransform( int handle, float px, float py, float pz, float qx, float qy, float qz, float qs )
{
	int slot = Slot( handle );
	if ( slot >= 0 )
	{
		b3Body_SetTransform( g_bodies[slot], (b3Pos){ px, py, pz }, (b3Quat){ { qx, qy, qz }, qs } );
	}
}

// Kinematic body motion: engine computes velocity to arrive at target next step.
EMSCRIPTEN_KEEPALIVE
void w3_SetTargetTransform( int handle, float px, float py, float pz, float qx, float qy, float qz, float qs, float dt )
{
	int slot = Slot( handle );
	if ( slot >= 0 )
	{
		b3WorldTransform target = { { px, py, pz }, { { qx, qy, qz }, qs } };
		b3Body_SetTargetTransform( g_bodies[slot], target, dt, true );
	}
}

EMSCRIPTEN_KEEPALIVE
void w3_SetLinearVelocity( int handle, float vx, float vy, float vz )
{
	int slot = Slot( handle );
	if ( slot >= 0 )
	{
		b3Body_SetLinearVelocity( g_bodies[slot], (b3Vec3){ vx, vy, vz } );
	}
}

EMSCRIPTEN_KEEPALIVE
void w3_SetAngularVelocity( int handle, float wx, float wy, float wz )
{
	int slot = Slot( handle );
	if ( slot >= 0 )
	{
		b3Body_SetAngularVelocity( g_bodies[slot], (b3Vec3){ wx, wy, wz } );
	}
}

EMSCRIPTEN_KEEPALIVE
void w3_ApplyImpulse( int handle, float ix, float iy, float iz )
{
	int slot = Slot( handle );
	if ( slot >= 0 )
	{
		b3Body_ApplyLinearImpulseToCenter( g_bodies[slot], (b3Vec3){ ix, iy, iz }, true );
	}
}

EMSCRIPTEN_KEEPALIVE
void w3_ApplyImpulseAt( int handle, float ix, float iy, float iz, float px, float py, float pz )
{
	int slot = Slot( handle );
	if ( slot >= 0 )
	{
		b3Body_ApplyLinearImpulse( g_bodies[slot], (b3Vec3){ ix, iy, iz }, (b3Pos){ px, py, pz }, true );
	}
}

// Per-step force (force fields: rope air jets, plinko magnets, draw wind).
EMSCRIPTEN_KEEPALIVE
void w3_ApplyForce( int handle, float fx, float fy, float fz )
{
	int slot = Slot( handle );
	if ( slot >= 0 )
	{
		b3Body_ApplyForceToCenter( g_bodies[slot], (b3Vec3){ fx, fy, fz }, true );
	}
}

EMSCRIPTEN_KEEPALIVE
void w3_ApplyTorque( int handle, float tx, float ty, float tz )
{
	int slot = Slot( handle );
	if ( slot >= 0 )
	{
		b3Body_ApplyTorque( g_bodies[slot], (b3Vec3){ tx, ty, tz }, true );
	}
}

EMSCRIPTEN_KEEPALIVE
void w3_SetGravityScale( int handle, float scale )
{
	int slot = Slot( handle );
	if ( slot >= 0 )
	{
		b3Body_SetGravityScale( g_bodies[slot], scale );
	}
}

EMSCRIPTEN_KEEPALIVE
void w3_SetAwake( int handle, int awake )
{
	int slot = Slot( handle );
	if ( slot >= 0 )
	{
		b3Body_SetAwake( g_bodies[slot], awake != 0 );
	}
}

EMSCRIPTEN_KEEPALIVE
void w3_SetEnabled( int handle, int enabled )
{
	int slot = Slot( handle );
	if ( slot < 0 )
	{
		return;
	}
	if ( enabled )
	{
		b3Body_Enable( g_bodies[slot] );
	}
	else
	{
		b3Body_Disable( g_bodies[slot] );
	}
}

// Static/kinematic/dynamic swap (hole: city props wake into dynamic as the hole nears).
EMSCRIPTEN_KEEPALIVE
void w3_SetBodyType( int handle, int type )
{
	int slot = Slot( handle );
	if ( slot >= 0 )
	{
		b3Body_SetType( g_bodies[slot], (b3BodyType)type );
	}
}

// Collision filter on every shape of the body (hole: drop floor collision per body).
EMSCRIPTEN_KEEPALIVE
void w3_SetFilter( int handle, int categoryBits, int maskBits, int groupIndex )
{
	int slot = Slot( handle );
	if ( slot < 0 )
	{
		return;
	}
	b3ShapeId shapes[MAX_SHAPES_PER_BODY];
	int count = b3Body_GetShapes( g_bodies[slot], shapes, MAX_SHAPES_PER_BODY );
	b3Filter filter = { (uint64_t)(uint32_t)categoryBits, (uint64_t)(uint32_t)maskBits, groupIndex };
	for ( int i = 0; i < count; ++i )
	{
		b3Shape_SetFilter( shapes[i], filter, true );
	}
}

// Diagnostic: read back the first shape's filter categoryBits (-100 bad handle, -200 no shapes).
EMSCRIPTEN_KEEPALIVE
int w3_DebugGetFilterCategory( int handle )
{
	int slot = Slot( handle );
	if ( slot < 0 )
	{
		return -100;
	}
	b3ShapeId shapes[8];
	int n = b3Body_GetShapes( g_bodies[slot], shapes, 8 );
	if ( n == 0 )
	{
		return -200;
	}
	b3Filter f = b3Shape_GetFilter( shapes[0] );
	return (int)f.categoryBits;
}

EMSCRIPTEN_KEEPALIVE
float w3_GetMass( int handle )
{
	int slot = Slot( handle );
	return slot >= 0 ? b3Body_GetMass( g_bodies[slot] ) : 0.0f;
}

// ---- joints ----

static int StoreJoint( b3JointId id, int type )
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
		b3DestroyJoint( id, true );
		return -1;
	}
	g_joints[slot] = id;
	g_jointValid[slot] = true;
	g_jointType[slot] = type;
	return ( (int)g_jointGen[slot] << 16 ) | slot;
}

// Hinge about world axis (ax,ay,az) through world anchor.
EMSCRIPTEN_KEEPALIVE
int w3_CreateRevoluteJoint( int handleA, int handleB, float px, float py, float pz, float ax, float ay, float az,
							float lower, float upper, int enableLimit, float motorSpeed, float maxMotorTorque,
							int enableMotor, int collideConnected )
{
	int a = Slot( handleA );
	int b = Slot( handleB );
	if ( a < 0 || b < 0 )
	{
		return -1;
	}
	b3Pos anchor = { px, py, pz };
	// Box3D revolute rotates about the joint frame z-axis.
	b3Quat worldRot = QuatFromTo( (b3Vec3){ 0.0f, 0.0f, 1.0f }, b3Normalize( (b3Vec3){ ax, ay, az } ) );
	b3RevoluteJointDef def = b3DefaultRevoluteJointDef();
	def.base.bodyIdA = g_bodies[a];
	def.base.bodyIdB = g_bodies[b];
	def.base.localFrameA = LocalFrame( g_bodies[a], anchor, worldRot );
	def.base.localFrameB = LocalFrame( g_bodies[b], anchor, worldRot );
	def.base.collideConnected = collideConnected != 0;
	def.enableLimit = enableLimit != 0;
	def.lowerAngle = lower;
	def.upperAngle = upper;
	def.enableMotor = enableMotor != 0;
	def.motorSpeed = motorSpeed;
	def.maxMotorTorque = maxMotorTorque;
	return StoreJoint( b3CreateRevoluteJoint( g_world, &def ), 0 );
}

// Slider along world axis (ax,ay,az) through world anchor.
EMSCRIPTEN_KEEPALIVE
int w3_CreatePrismaticJoint( int handleA, int handleB, float px, float py, float pz, float ax, float ay, float az,
							 float lower, float upper, int enableLimit, float motorSpeed, float maxMotorForce,
							 int enableMotor )
{
	int a = Slot( handleA );
	int b = Slot( handleB );
	if ( a < 0 || b < 0 )
	{
		return -1;
	}
	b3Pos anchor = { px, py, pz };
	// Box3D prismatic slides along the local frame A x-axis.
	b3Quat worldRot = QuatFromTo( (b3Vec3){ 1.0f, 0.0f, 0.0f }, b3Normalize( (b3Vec3){ ax, ay, az } ) );
	b3PrismaticJointDef def = b3DefaultPrismaticJointDef();
	def.base.bodyIdA = g_bodies[a];
	def.base.bodyIdB = g_bodies[b];
	def.base.localFrameA = LocalFrame( g_bodies[a], anchor, worldRot );
	def.base.localFrameB = LocalFrame( g_bodies[b], anchor, worldRot );
	def.enableLimit = enableLimit != 0;
	def.lowerTranslation = lower;
	def.upperTranslation = upper;
	def.enableMotor = enableMotor != 0;
	def.motorSpeed = motorSpeed;
	def.maxMotorForce = maxMotorForce;
	return StoreJoint( b3CreatePrismaticJoint( g_world, &def ), 1 );
}

EMSCRIPTEN_KEEPALIVE
int w3_CreateDistanceJoint( int handleA, int handleB, float ax, float ay, float az, float bx, float by, float bz,
							float length, float minLength, float maxLength, int enableLimit, float hertz,
							float dampingRatio, int enableSpring, int collideConnected )
{
	int a = Slot( handleA );
	int b = Slot( handleB );
	if ( a < 0 || b < 0 )
	{
		return -1;
	}
	b3DistanceJointDef def = b3DefaultDistanceJointDef();
	def.base.bodyIdA = g_bodies[a];
	def.base.bodyIdB = g_bodies[b];
	def.base.localFrameA.p = b3Body_GetLocalPoint( g_bodies[a], (b3Pos){ ax, ay, az } );
	def.base.localFrameB.p = b3Body_GetLocalPoint( g_bodies[b], (b3Pos){ bx, by, bz } );
	def.base.collideConnected = collideConnected != 0;
	def.length = length;
	def.enableSpring = enableSpring != 0;
	def.hertz = hertz;
	def.dampingRatio = dampingRatio;
	def.enableLimit = enableLimit != 0;
	def.minLength = minLength;
	def.maxLength = maxLength;
	return StoreJoint( b3CreateDistanceJoint( g_world, &def ), 2 );
}

// Ball joint (helix pendulum pole).
EMSCRIPTEN_KEEPALIVE
int w3_CreateSphericalJoint( int handleA, int handleB, float px, float py, float pz, float coneAngle, int enableConeLimit )
{
	int a = Slot( handleA );
	int b = Slot( handleB );
	if ( a < 0 || b < 0 )
	{
		return -1;
	}
	b3Pos anchor = { px, py, pz };
	b3SphericalJointDef def = b3DefaultSphericalJointDef();
	def.base.bodyIdA = g_bodies[a];
	def.base.bodyIdB = g_bodies[b];
	def.base.localFrameA = LocalFrame( g_bodies[a], anchor, b3Quat_identity );
	def.base.localFrameB = LocalFrame( g_bodies[b], anchor, b3Quat_identity );
	def.enableConeLimit = enableConeLimit != 0;
	def.coneAngle = coneAngle;
	return StoreJoint( b3CreateSphericalJoint( g_world, &def ), 3 );
}

EMSCRIPTEN_KEEPALIVE
void w3_DestroyJoint( int jointHandle )
{
	int slot = JointSlot( jointHandle );
	if ( slot < 0 )
	{
		return;
	}
	b3DestroyJoint( g_joints[slot], true );
	g_jointValid[slot] = false;
	g_jointGen[slot] = (uint16_t)( ( g_jointGen[slot] + 1 ) & 0x7FFF );
	if ( g_jointGen[slot] == 0 )
	{
		g_jointGen[slot] = 1;
	}
	g_jointFree[g_jointFreeCount++] = slot;
}

EMSCRIPTEN_KEEPALIVE
void w3_SetMotorSpeed( int jointHandle, float speed )
{
	int slot = JointSlot( jointHandle );
	if ( slot < 0 )
	{
		return;
	}
	if ( g_jointType[slot] == 0 )
	{
		b3RevoluteJoint_SetMotorSpeed( g_joints[slot], speed );
	}
	else if ( g_jointType[slot] == 1 )
	{
		b3PrismaticJoint_SetMotorSpeed( g_joints[slot], speed );
	}
}

// ---- queries ----

// Closest-hit raycast. Returns 1 on hit; result in w3_GetRayResultPtr buffer.
EMSCRIPTEN_KEEPALIVE
int w3_CastRayClosest( float ox, float oy, float oz, float tx, float ty, float tz, int categoryBits, int maskBits )
{
	b3QueryFilter filter = b3DefaultQueryFilter();
	filter.categoryBits = (uint64_t)(uint32_t)categoryBits;
	filter.maskBits = (uint64_t)(uint32_t)maskBits;
	b3RayResult result = b3World_CastRayClosest( g_world, (b3Pos){ ox, oy, oz }, (b3Vec3){ tx, ty, tz }, filter );
	if ( !result.hit )
	{
		g_rayResult[7] = -1.0f;
		return 0;
	}
	g_rayResult[0] = (float)result.point.x;
	g_rayResult[1] = (float)result.point.y;
	g_rayResult[2] = (float)result.point.z;
	g_rayResult[3] = result.normal.x;
	g_rayResult[4] = result.normal.y;
	g_rayResult[5] = result.normal.z;
	g_rayResult[6] = result.fraction;
	g_rayResult[7] = (float)SlotFromShape( result.shapeId );
	return 1;
}

// ---- step & event collection ----

EMSCRIPTEN_KEEPALIVE
void w3_Step( float dt, int subStepCount )
{
	b3World_Step( g_world, dt, subStepCount );

	for ( int i = 0; i < g_highSlot; ++i )
	{
		float* s = g_states + i * STATE_STRIDE;
		if ( !g_valid[i] )
		{
			s[8] = 0.0f;
			continue;
		}
		b3WorldTransform xf = b3Body_GetTransform( g_bodies[i] );
		b3Vec3 v = b3Body_GetLinearVelocity( g_bodies[i] );
		b3Vec3 w = b3Body_GetAngularVelocity( g_bodies[i] );
		s[0] = (float)xf.p.x;
		s[1] = (float)xf.p.y;
		s[2] = (float)xf.p.z;
		s[3] = xf.q.v.x;
		s[4] = xf.q.v.y;
		s[5] = xf.q.v.z;
		s[6] = xf.q.s;
		s[7] = b3Body_IsAwake( g_bodies[i] ) ? 1.0f : 0.0f;
		s[8] = 1.0f;
		s[9] = v.x;
		s[10] = v.y;
		s[11] = v.z;
		s[12] = w.x;
		s[13] = w.y;
		s[14] = w.z;
	}

	b3ContactEvents contacts = b3World_GetContactEvents( g_world );

	int hitCount = contacts.hitCount < MAX_HITS ? contacts.hitCount : MAX_HITS;
	g_hitCount = hitCount;
	for ( int i = 0; i < hitCount; ++i )
	{
		const b3ContactHitEvent* hit = contacts.hitEvents + i;
		float* h = g_hits + i * HIT_STRIDE;
		int slotA = SlotFromShape( hit->shapeIdA );
		int slotB = SlotFromShape( hit->shapeIdB );
		h[0] = (float)hit->point.x;
		h[1] = (float)hit->point.y;
		h[2] = (float)hit->point.z;
		h[3] = hit->normal.x;
		h[4] = hit->normal.y;
		h[5] = hit->normal.z;
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
		const b3ContactBeginTouchEvent* ev = contacts.beginEvents + i;
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
		const b3ContactEndTouchEvent* ev = contacts.endEvents + i;
		float* c = g_contactEnd + i * CONTACT_STRIDE;
		int slotA = SlotFromShape( ev->shapeIdA );
		int slotB = SlotFromShape( ev->shapeIdB );
		c[0] = (float)slotA;
		c[1] = slotA >= 0 ? (float)g_userData[slotA] : 0.0f;
		c[2] = (float)slotB;
		c[3] = slotB >= 0 ? (float)g_userData[slotB] : 0.0f;
	}

	b3SensorEvents sensors = b3World_GetSensorEvents( g_world );

	int sBegin = sensors.beginCount < MAX_SENSOR_EVENTS ? sensors.beginCount : MAX_SENSOR_EVENTS;
	g_sensorBeginCount = sBegin;
	for ( int i = 0; i < sBegin; ++i )
	{
		const b3SensorBeginTouchEvent* ev = sensors.beginEvents + i;
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
		const b3SensorEndTouchEvent* ev = sensors.endEvents + i;
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
float* w3_GetStatesPtr( void )
{
	return g_states;
}

EMSCRIPTEN_KEEPALIVE
int w3_GetStateStride( void )
{
	return STATE_STRIDE;
}

EMSCRIPTEN_KEEPALIVE
int w3_GetMaxBodies( void )
{
	return MAX_BODIES;
}

EMSCRIPTEN_KEEPALIVE
float* w3_GetHitsPtr( void )
{
	return g_hits;
}

EMSCRIPTEN_KEEPALIVE
int w3_GetHitCount( void )
{
	return g_hitCount;
}

EMSCRIPTEN_KEEPALIVE
float* w3_GetContactBeginPtr( void )
{
	return g_contactBegin;
}

EMSCRIPTEN_KEEPALIVE
int w3_GetContactBeginCount( void )
{
	return g_contactBeginCount;
}

EMSCRIPTEN_KEEPALIVE
float* w3_GetContactEndPtr( void )
{
	return g_contactEnd;
}

EMSCRIPTEN_KEEPALIVE
int w3_GetContactEndCount( void )
{
	return g_contactEndCount;
}

EMSCRIPTEN_KEEPALIVE
float* w3_GetSensorBeginPtr( void )
{
	return g_sensorBegin;
}

EMSCRIPTEN_KEEPALIVE
int w3_GetSensorBeginCount( void )
{
	return g_sensorBeginCount;
}

EMSCRIPTEN_KEEPALIVE
float* w3_GetSensorEndPtr( void )
{
	return g_sensorEnd;
}

EMSCRIPTEN_KEEPALIVE
int w3_GetSensorEndCount( void )
{
	return g_sensorEndCount;
}

EMSCRIPTEN_KEEPALIVE
float* w3_GetRayResultPtr( void )
{
	return g_rayResult;
}
