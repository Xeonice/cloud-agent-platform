#!/bin/sh
# Shared install-time dependency checks for the source-free release installer.
# POSIX-compatible on purpose: apps/www/public/install.sh runs under `sh`, while
# scripts/quick-deploy.sh sources the same helpers from bash.

cap_preflight_log() {
  printf '%s\n' "$*"
}

cap_preflight_warn() {
  printf 'warn: %s\n' "$*" >&2
}

cap_preflight_die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

cap_command_exists() {
  command -v "$1" >/dev/null 2>&1
}

cap_host_os() {
  if [ -n "${CAP_TEST_UNAME:-}" ]; then
    printf '%s\n' "$CAP_TEST_UNAME"
    return 0
  fi
  uname -s 2>/dev/null || printf '%s\n' unknown
}

cap_macos_homebrew_bin_dirs() {
  if [ -n "${CAP_TEST_HOMEBREW_BIN_DIRS:-}" ]; then
    printf '%s\n' "$CAP_TEST_HOMEBREW_BIN_DIRS"
    return 0
  fi
  printf '%s\n' /opt/homebrew/bin /usr/local/bin
}

cap_macos_adopt_homebrew_tool_path() {
  _cap_tool="$1"
  if [ "${CAP_TEST_IGNORE_SYSTEM_BREW:-}" = "1" ]; then
    return 1
  fi
  for _cap_brew_dir in $(cap_macos_homebrew_bin_dirs); do
    if [ -x "$_cap_brew_dir/$_cap_tool" ]; then
      PATH="$_cap_brew_dir:$PATH"
      export PATH
      return 0
    fi
  done
  return 1
}

cap_require_tools() {
  _cap_missing=""
  for _cap_tool in "$@"; do
    if ! cap_command_exists "$_cap_tool"; then
      _cap_missing="${_cap_missing} ${_cap_tool}"
    fi
  done
  if [ -n "$_cap_missing" ]; then
    cap_preflight_die "missing required install-time tool(s):${_cap_missing}"
  fi
}

cap_run_with_timeout() {
  _cap_timeout="$1"
  shift
  "$@" &
  _cap_pid=$!
  (
    sleep "$_cap_timeout"
    kill "$_cap_pid" >/dev/null 2>&1 || true
  ) &
  _cap_watchdog=$!
  wait "$_cap_pid"
  _cap_status=$?
  kill "$_cap_watchdog" >/dev/null 2>&1 || true
  wait "$_cap_watchdog" >/dev/null 2>&1 || true
  return "$_cap_status"
}

cap_docker_state() {
  if ! cap_command_exists docker && [ "$(cap_host_os)" = "Darwin" ]; then
    cap_macos_adopt_homebrew_tool_path docker || true
  fi
  if ! cap_command_exists docker; then
    printf '%s\n' absent
    return 0
  fi
  if ! cap_run_with_timeout 12 docker compose version >/dev/null 2>&1; then
    printf '%s\n' missing-compose
    return 0
  fi
  if cap_run_with_timeout 12 docker info >/dev/null 2>&1; then
    printf '%s\n' usable
    return 0
  fi
  printf '%s\n' unreachable
}

cap_run_privileged() {
  if [ "${CAP_TEST_ASSUME_ROOT:-}" = "1" ] || [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then
    "$@"
    return $?
  fi
  if cap_command_exists sudo; then
    sudo "$@"
    return $?
  fi
  cap_preflight_die "administrator privileges are required to install Docker; install Docker manually, then re-run"
}

cap_linux_install_docker_packages() {
  _cap_package_set="$1"
  if [ "${CAP_INSTALL_DRY_RUN:-}" = "1" ]; then
    case "$_cap_package_set" in
      docker-and-compose) cap_preflight_log "dry-run: would install Docker Engine and Docker Compose plugin on Linux" ;;
      compose-only) cap_preflight_log "dry-run: would install Docker Compose plugin on Linux" ;;
    esac
    return 0
  fi
  if cap_command_exists apt-get; then
    cap_run_privileged apt-get update
    if [ "$_cap_package_set" = "compose-only" ]; then
      cap_run_privileged apt-get install -y docker-compose-plugin || \
        cap_run_privileged apt-get install -y docker-compose-v2
    else
      cap_run_privileged apt-get install -y docker.io docker-compose-plugin || \
        cap_run_privileged apt-get install -y docker.io docker-compose-v2
    fi
  elif cap_command_exists dnf; then
    if [ "$_cap_package_set" = "compose-only" ]; then
      cap_run_privileged dnf install -y docker-compose-plugin
    else
      cap_run_privileged dnf install -y docker docker-compose-plugin
    fi
  elif cap_command_exists yum; then
    if [ "$_cap_package_set" = "compose-only" ]; then
      cap_run_privileged yum install -y docker-compose-plugin
    else
      cap_run_privileged yum install -y docker docker-compose-plugin
    fi
  elif cap_command_exists zypper; then
    if [ "$_cap_package_set" = "compose-only" ]; then
      cap_run_privileged zypper --non-interactive install docker-compose
    else
      cap_run_privileged zypper --non-interactive install docker docker-compose
    fi
  elif cap_command_exists apk; then
    if [ "$_cap_package_set" = "compose-only" ]; then
      cap_run_privileged apk add docker-cli-compose
    else
      cap_run_privileged apk add docker docker-cli-compose
    fi
  elif cap_command_exists pacman; then
    if [ "$_cap_package_set" = "compose-only" ]; then
      cap_run_privileged pacman -Sy --noconfirm docker-compose
    else
      cap_run_privileged pacman -Sy --noconfirm docker docker-compose
    fi
  else
    case "$_cap_package_set" in
      compose-only)
        cap_preflight_die "Docker Compose is absent and this Linux distribution has no supported package manager on PATH; install the Docker Compose plugin, then re-run"
        ;;
      *)
        cap_preflight_die "Docker is absent and this Linux distribution has no supported package manager on PATH; install Docker Engine plus Docker Compose, then re-run"
        ;;
    esac
  fi
}

cap_linux_install_docker() {
  cap_linux_install_docker_packages docker-and-compose
}

cap_linux_install_compose() {
  cap_linux_install_docker_packages compose-only
}

cap_macos_homebrew_install_url() {
  printf '%s\n' "${CAP_HOMEBREW_INSTALL_URL:-https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh}"
}

cap_macos_ensure_homebrew() {
  if cap_command_exists brew; then
    return 0
  fi
  if [ "${CAP_TEST_IGNORE_SYSTEM_BREW:-}" != "1" ]; then
    for _cap_brew_dir in $(cap_macos_homebrew_bin_dirs); do
      if [ -x "$_cap_brew_dir/brew" ]; then
        PATH="$_cap_brew_dir:$PATH"
        export PATH
        return 0
      fi
    done
  fi
  _cap_homebrew_url="$(cap_macos_homebrew_install_url)"
  if [ "${CAP_INSTALL_DRY_RUN:-}" = "1" ]; then
    cap_preflight_log "dry-run: would install Homebrew for macOS Docker installation from $_cap_homebrew_url"
    return 0
  fi
  cap_command_exists curl || cap_preflight_die "curl is required to install Homebrew for macOS Docker installation"
  [ -x /bin/bash ] || cap_preflight_die "/bin/bash is required to install Homebrew for macOS Docker installation"
  _cap_homebrew_tmp="${TMPDIR:-/tmp}/cap-homebrew-install.$$"
  cap_preflight_log "install-time dependency: Homebrew is absent; installing Homebrew non-interactively from $_cap_homebrew_url"
  curl -fsSL "$_cap_homebrew_url" -o "$_cap_homebrew_tmp" || {
    _cap_status=$?
    rm -f "$_cap_homebrew_tmp"
    cap_preflight_die "could not fetch Homebrew installer from $_cap_homebrew_url (curl exit $_cap_status). Check DNS/egress/proxy for this macOS host or set CAP_HOMEBREW_INSTALL_URL to a reachable installer mirror."
  }
  NONINTERACTIVE=1 /bin/bash "$_cap_homebrew_tmp" || {
    _cap_status=$?
    rm -f "$_cap_homebrew_tmp"
    cap_preflight_die "Homebrew installer failed with exit $_cap_status. On a fresh macOS host, Homebrew also requires Xcode Command Line Tools to be installable via Apple Software Update; install Homebrew/CLT manually, fix macOS softwareupdate/proxy egress, or set CAP_HOMEBREW_INSTALL_URL to a working installer, then re-run"
  }
  rm -f "$_cap_homebrew_tmp"
  if ! cap_command_exists brew; then
    for _cap_brew_dir in $(cap_macos_homebrew_bin_dirs); do
      if [ -x "$_cap_brew_dir/brew" ]; then
        PATH="$_cap_brew_dir:$PATH"
        export PATH
        break
      fi
    done
  fi
  cap_command_exists brew || \
    cap_preflight_die "Homebrew installation finished but 'brew' is not on PATH; add Homebrew to PATH, then re-run"
}

cap_macos_brew_formula_installed() {
  brew list --formula "$1" >/dev/null 2>&1 || brew list "$1" >/dev/null 2>&1
}

cap_macos_install_missing_brew_formulas() {
  _cap_missing_formulas=""
  for _cap_formula in "$@"; do
    if ! cap_macos_brew_formula_installed "$_cap_formula"; then
      _cap_missing_formulas="${_cap_missing_formulas} ${_cap_formula}"
    fi
  done
  if [ -z "$_cap_missing_formulas" ]; then
    cap_preflight_log "install-time dependency: requested Homebrew formula(s) already installed; leaving them untouched"
    return 0
  fi
  if [ "${CAP_INSTALL_DRY_RUN:-}" = "1" ]; then
    cap_preflight_log "dry-run: would install missing Homebrew formula(s):${_cap_missing_formulas}"
    return 0
  fi
  # shellcheck disable=SC2086
  brew install $_cap_missing_formulas
}

cap_macos_install_docker() {
  cap_macos_ensure_homebrew
  cap_macos_install_missing_brew_formulas docker docker-compose colima
  cap_macos_configure_compose_plugin
}

cap_macos_install_compose() {
  cap_macos_ensure_homebrew
  cap_macos_install_missing_brew_formulas docker-compose
  cap_macos_configure_compose_plugin
}

cap_macos_configure_compose_plugin() {
  _cap_brew_prefix="$(brew --prefix 2>/dev/null || true)"
  for _cap_compose_plugin in \
    "$_cap_brew_prefix/lib/docker/cli-plugins/docker-compose" \
    /opt/homebrew/lib/docker/cli-plugins/docker-compose \
    /usr/local/lib/docker/cli-plugins/docker-compose
  do
    if [ -n "$_cap_compose_plugin" ] && [ -x "$_cap_compose_plugin" ]; then
      mkdir -p "${HOME:-$PWD}/.docker/cli-plugins"
      ln -sf "$_cap_compose_plugin" "${HOME:-$PWD}/.docker/cli-plugins/docker-compose"
      cap_preflight_log "install-time dependency: configured Docker Compose plugin at ${HOME:-$PWD}/.docker/cli-plugins/docker-compose"
      return 0
    fi
  done
}

cap_safe_start_docker() {
  _cap_os="$(cap_host_os)"
  case "$_cap_os" in
    Linux)
      if cap_command_exists systemctl; then
        if [ "${CAP_INSTALL_DRY_RUN:-}" = "1" ]; then
          cap_preflight_log "dry-run: would start docker with systemctl"
        elif [ "$(id -u 2>/dev/null || echo 1)" = "0" ] || [ "${CAP_TEST_ASSUME_ROOT:-}" = "1" ]; then
          systemctl start docker >/dev/null 2>&1 || true
        elif cap_command_exists sudo; then
          sudo -n systemctl start docker >/dev/null 2>&1 || true
        fi
      elif cap_command_exists service; then
        if [ "${CAP_INSTALL_DRY_RUN:-}" = "1" ]; then
          cap_preflight_log "dry-run: would start docker with service"
        elif [ "$(id -u 2>/dev/null || echo 1)" = "0" ] || [ "${CAP_TEST_ASSUME_ROOT:-}" = "1" ]; then
          service docker start >/dev/null 2>&1 || true
        elif cap_command_exists sudo; then
          sudo -n service docker start >/dev/null 2>&1 || true
        fi
      elif cap_command_exists rc-service; then
        if [ "${CAP_INSTALL_DRY_RUN:-}" = "1" ]; then
          cap_preflight_log "dry-run: would start docker with rc-service"
        else
          cap_run_privileged rc-service docker start >/dev/null 2>&1 || true
        fi
      fi
      ;;
    Darwin)
      if cap_command_exists colima; then
        if [ "${CAP_INSTALL_DRY_RUN:-}" = "1" ]; then
          cap_preflight_log "dry-run: would start Colima"
        else
          colima start >/dev/null 2>&1 || true
        fi
      elif cap_command_exists open; then
        open -ga Docker >/dev/null 2>&1 || true
      fi
      ;;
  esac
}

cap_wait_for_docker_info() {
  _cap_deadline=$(( $(date +%s) + ${1:-60} ))
  while [ "$(date +%s)" -le "$_cap_deadline" ]; do
    if cap_run_with_timeout 12 docker info >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

cap_ensure_docker() {
  if [ "$(cap_host_os)" = "Darwin" ] && ! cap_command_exists docker; then
    cap_macos_adopt_homebrew_tool_path docker || true
  fi
  _cap_state="$(cap_docker_state)"
  case "$_cap_state" in
    usable)
      cap_preflight_log "install-time dependency: Docker CLI, Compose, and engine are usable; leaving Docker untouched"
      return 0
      ;;
    absent)
      cap_preflight_log "install-time dependency: Docker is absent; attempting supported installation"
      case "$(cap_host_os)" in
        Linux) cap_linux_install_docker ;;
        Darwin) cap_macos_install_docker ;;
        *) cap_preflight_die "Docker is absent and automatic Docker installation is unsupported on $(cap_host_os)" ;;
      esac
      cap_safe_start_docker
      ;;
    missing-compose)
      cap_preflight_log "install-time dependency: Docker CLI is present but Docker Compose is missing; installing only the Compose plugin"
      case "$(cap_host_os)" in
        Linux) cap_linux_install_compose ;;
        Darwin)
          if cap_command_exists brew; then
            cap_macos_configure_compose_plugin
          fi
          _cap_state="$(cap_docker_state)"
          if [ "$_cap_state" = "missing-compose" ]; then
            cap_macos_install_compose
          fi
          ;;
        *) cap_preflight_die "Docker Compose is missing and automatic Compose installation is unsupported on $(cap_host_os)" ;;
      esac
      _cap_state="$(cap_docker_state)"
      case "$_cap_state" in
        usable)
          cap_preflight_log "install-time dependency: Docker is usable"
          return 0
          ;;
        unreachable)
          cap_preflight_log "install-time dependency: Docker is installed but the daemon/socket/context is unreachable; attempting bounded safe start"
          cap_safe_start_docker
          ;;
        missing-compose) ;;
        *) cap_preflight_die "unknown Docker preflight state after Compose plugin installation: $_cap_state" ;;
      esac
      ;;
    unreachable)
      cap_preflight_log "install-time dependency: Docker is installed but the daemon/socket/context is unreachable; attempting bounded safe start"
      cap_safe_start_docker
      ;;
    *)
      cap_preflight_die "unknown Docker preflight state: $_cap_state"
      ;;
  esac

  _cap_after="$(cap_docker_state)"
  if [ "$_cap_after" = "usable" ]; then
    cap_preflight_log "install-time dependency: Docker is usable"
    return 0
  fi
  case "$_cap_after" in
    absent)
      cap_preflight_die "Docker installation did not place 'docker' on PATH; install Docker manually, then re-run"
      ;;
    missing-compose)
      cap_preflight_die "Docker is installed, but 'docker compose' is still unavailable; install the Compose plugin, then re-run"
      ;;
    unreachable)
      cap_preflight_die "Docker is installed but docker.sock is not reachable after bounded safe starts. Start Docker, fix socket permissions or docker context, then re-run"
      ;;
    *)
      cap_preflight_die "Docker is not usable after preflight: $_cap_after"
      ;;
  esac
}

cap_print_dependency_report() {
  cat <<EOF
Install-time dependencies:
  required now: sh, curl, bash, openssl, awk, Docker CLI, Docker Compose, reachable docker.sock/context
  fetched during install: CAP release installer assets, GHCR cap images, Docker Hub postgres image
  dependency install policy: leave usable Docker untouched; install only absent Docker components or a missing Compose plugin; never reinstall Docker for an unreachable daemon/socket/context
  macOS missing-Docker or missing-Compose: Homebrew installer ($(cap_macos_homebrew_install_url)) only when brew is absent, Xcode Command Line Tools via Apple Software Update when absent, plus missing Homebrew formula/bottle downloads for docker, docker-compose, and colima
  provider readiness: Linux/AIO stages cap-aio-sandbox; BoxLite validates BOXLITE endpoint/token/image/protocol and native create/start/exec runtime tools; local BoxLite control planes additionally require macOS Apple Silicon 12.0+ with kern.hv_support=1 or Linux/WSL2 with read/write /dev/kvm
Task-time optional dependencies:
  repository host access, forge credentials, GitHub API validation token when enabled, OpenAI/Claude auth, task package registries, SMTP, public DNS/TLS/proxy, external Postgres
EOF
}
