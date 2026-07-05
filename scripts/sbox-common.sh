#!/usr/bin/env bash
# sbox-common.sh — S&box runtime helpers shared by qq shell scripts

qq_find_sbox_project_file() {
    local project_dir="$1"
    if [[ -f "$project_dir/.sbproj" ]]; then
        printf '%s\n' "$project_dir/.sbproj"
        return 0
    fi
    find "$project_dir" -maxdepth 1 -type f -name '*.sbproj' | sort | head -1 || true
}

qq_is_sbox_project() {
    local project_dir="$1"
    [[ -n "$(qq_find_sbox_project_file "$project_dir")" ]]
}

qq_find_sbox_dotnet() {
    if [[ -n "${DOTNET_BIN:-}" && -x "${DOTNET_BIN}" ]]; then
        printf '%s\n' "${DOTNET_BIN}"
        return 0
    fi
    command -v dotnet 2>/dev/null || return 1
}

qq_find_sbox_editor_cmd() {
    local candidates=()
    if [[ -n "${SBOX_EDITOR_CMD:-}" ]]; then
        candidates+=("${SBOX_EDITOR_CMD}")
    fi
    if [[ -n "${SBOX_CMD:-}" ]]; then
        candidates+=("${SBOX_CMD}")
    fi
    candidates+=(
        sbox
        /Applications/sbox.app/Contents/MacOS/sbox
        "/Applications/s&box.app/Contents/MacOS/sbox"
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

qq_find_sbox_server_cmd() {
    local candidates=()
    if [[ -n "${SBOX_SERVER_CMD:-}" ]]; then
        candidates+=("${SBOX_SERVER_CMD}")
    fi
    candidates+=(
        sbox-server
        sbox-server.exe
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

qq_find_sbox_solution() {
    local project_dir="$1"
    find "$project_dir" -maxdepth 1 -type f -name '*.sln' | sort | head -1 || true
}

qq_list_sbox_csproj() {
    local project_dir="$1"
    find "$project_dir" -type f -name '*.csproj' ! -path '*/bin/*' ! -path '*/obj/*' | sort
}

qq_is_sbox_test_project_path() {
    local candidate="$1"
    local lowered
    lowered="$(printf '%s' "$candidate" | tr '[:upper:]' '[:lower:]')"
    [[ "$lowered" == *"/unittests/"* || "$lowered" == *"unittests"* || "$lowered" == *".tests.csproj" || "$lowered" == *".test.csproj" ]]
}

qq_list_sbox_compile_targets() {
    local project_dir="$1"
    local solution=""
    solution="$(qq_find_sbox_solution "$project_dir")"
    if [[ -n "$solution" ]]; then
        printf '%s\n' "$solution"
        return 0
    fi

    local csproj=""
    local fallback=()
    while IFS= read -r csproj; do
        [[ -n "$csproj" ]] || continue
        if qq_is_sbox_test_project_path "$csproj"; then
            fallback+=("$csproj")
            continue
        fi
        printf '%s\n' "$csproj"
    done < <(qq_list_sbox_csproj "$project_dir")

    if [[ ${#fallback[@]} -gt 0 ]]; then
        printf '%s\n' "${fallback[@]}"
    fi
}

qq_list_sbox_test_targets() {
    local project_dir="$1"
    [[ -d "$project_dir/UnitTests" ]] || return 0

    local csproj=""
    local found=0
    while IFS= read -r csproj; do
        [[ -n "$csproj" ]] || continue
        if qq_is_sbox_test_project_path "$csproj"; then
            printf '%s\n' "$csproj"
            found=1
        fi
    done < <(qq_list_sbox_csproj "$project_dir")

    if [[ "$found" -eq 1 ]]; then
        return 0
    fi

    local solution=""
    solution="$(qq_find_sbox_solution "$project_dir")"
    if [[ -n "$solution" ]]; then
        printf '%s\n' "$solution"
    fi
}

qq_sbox_has_unit_tests() {
    local project_dir="$1"
    [[ -d "$project_dir/UnitTests" ]]
}

qq_sbox_has_server_code() {
    local project_dir="$1"
    find "$project_dir" -type f -name '*.Server.cs' | grep -q .
}
