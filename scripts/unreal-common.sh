#!/usr/bin/env bash
# unreal-common.sh — Unreal runtime helpers shared by qq shell scripts

qq_find_unreal_project_file() {
    local project_dir="$1"
    find "$project_dir" -maxdepth 1 -type f -name '*.uproject' | sort | head -1 || true
}

qq_unreal_project_name() {
    local project_dir="$1"
    local project_file=""
    project_file="$(qq_find_unreal_project_file "$project_dir")"
    if [[ -z "$project_file" ]]; then
        return 1
    fi
    basename "$project_file" .uproject
}

qq_is_unreal_project() {
    local project_dir="$1"
    [[ -n "$(qq_find_unreal_project_file "$project_dir")" ]]
}

qq_unreal_host_platform() {
    case "$(uname -s)" in
        Darwin*) printf 'Mac\n' ;;
        Linux*) printf 'Linux\n' ;;
        MINGW*|MSYS*|CYGWIN*) printf 'Win64\n' ;;
        *) printf 'Unknown\n' ;;
    esac
}

qq_find_unreal_engine_root() {
    local candidates=()
    if [[ -n "${UNREAL_ENGINE_ROOT:-}" ]]; then
        candidates+=("${UNREAL_ENGINE_ROOT}")
    fi
    if [[ -n "${UE_ENGINE_ROOT:-}" ]]; then
        candidates+=("${UE_ENGINE_ROOT}")
    fi
    if [[ -n "${UE_ROOT:-}" ]]; then
        candidates+=("${UE_ROOT}")
    fi

    local candidate=""
    if [[ ${#candidates[@]} -gt 0 ]]; then
        for candidate in "${candidates[@]}"; do
            if [[ -d "$candidate/Engine" ]]; then
                printf '%s\n' "$candidate"
                return 0
            fi
        done
    fi
    return 1
}

qq_find_unreal_editor_cmd() {
    local candidates=()
    if [[ -n "${UNREAL_EDITOR_CMD:-}" ]]; then
        candidates+=("${UNREAL_EDITOR_CMD}")
    fi
    if [[ -n "${UE_EDITOR_CMD:-}" ]]; then
        candidates+=("${UE_EDITOR_CMD}")
    fi

    local engine_root=""
    engine_root="$(qq_find_unreal_engine_root || true)"
    if [[ -n "$engine_root" ]]; then
        candidates+=(
            "$engine_root/Engine/Binaries/Mac/UnrealEditor-Cmd"
            "$engine_root/Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor"
            "$engine_root/Engine/Binaries/Mac/UnrealEditor"
            "$engine_root/Engine/Binaries/Linux/UnrealEditor"
            "$engine_root/Engine/Binaries/Linux/UnrealEditor-Cmd"
            "$engine_root/Engine/Binaries/Win64/UnrealEditor-Cmd.exe"
            "$engine_root/Engine/Binaries/Win64/UnrealEditor.exe"
        )
    fi

    candidates+=(
        UnrealEditor-Cmd
        UnrealEditor
    )

    local candidate=""
    for candidate in "${candidates[@]}"; do
        if [[ -x "$candidate" ]]; then
            printf '%s\n' "$candidate"
            return 0
        fi
        if command -v "$candidate" >/dev/null 2>&1; then
            command -v "$candidate"
            return 0
        fi
    done
    return 1
}

qq_find_unreal_ubt() {
    local candidates=()
    if [[ -n "${UNREAL_UBT:-}" ]]; then
        candidates+=("${UNREAL_UBT}")
    fi
    if [[ -n "${UE_UBT:-}" ]]; then
        candidates+=("${UE_UBT}")
    fi

    local engine_root=""
    engine_root="$(qq_find_unreal_engine_root || true)"
    if [[ -n "$engine_root" ]]; then
        candidates+=(
            "$engine_root/Engine/Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.dll"
            "$engine_root/Engine/Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.exe"
            "$engine_root/Engine/Binaries/DotNET/UnrealBuildTool.exe"
        )
    fi

    local candidate=""
    if [[ ${#candidates[@]} -gt 0 ]]; then
        for candidate in "${candidates[@]}"; do
            if [[ -f "$candidate" ]]; then
                printf '%s\n' "$candidate"
                return 0
            fi
        done
    fi
    return 1
}

qq_find_unreal_dotnet() {
    if [[ -n "${DOTNET_BIN:-}" && -x "${DOTNET_BIN}" ]]; then
        printf '%s\n' "${DOTNET_BIN}"
        return 0
    fi
    local engine_root=""
    engine_root="$(qq_find_unreal_engine_root || true)"
    if [[ -n "$engine_root" ]]; then
        local candidates=(
            "$engine_root/Engine/Binaries/ThirdParty/DotNet/8.0.412/mac-arm64/dotnet"
            "$engine_root/Engine/Binaries/ThirdParty/DotNet/8.0.412/mac-x64/dotnet"
            "$engine_root/Engine/Binaries/ThirdParty/DotNet/8.0.412/linux-x64/dotnet"
            "$engine_root/Engine/Binaries/ThirdParty/DotNet/8.0.412/win-x64/dotnet.exe"
        )
        local candidate=""
        for candidate in "${candidates[@]}"; do
            if [[ -x "$candidate" ]]; then
                printf '%s\n' "$candidate"
                return 0
            fi
        done
    fi
    command -v dotnet 2>/dev/null || return 1
}

qq_unreal_has_native_source() {
    local project_dir="$1"
    [[ -d "$project_dir/Source" ]] || find "$project_dir/Plugins" -type f \( -name '*.Build.cs' -o -name '*.Target.cs' -o -name '*.cpp' -o -name '*.h' \) -print -quit 2>/dev/null | grep -q .
}
