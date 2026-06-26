# Local one-click dev (local-one-click-dev). The logic lives in scripts/dev-*.sh;
# these targets are just memorable entry points. `make up` takes a freshly-cloned
# repo to a running + login-able stack with a single command.
.PHONY: help up up-aio up-boxlite up-cp down down-v

help:
	@echo "make up          auto-select sandbox provider (macOS→BoxLite, Linux→AIO),"
	@echo "                 bootstrap apps/api/.env, wait for /health, print auth token"
	@echo "make up-aio      force AIO full stack (incl. cap-aio-sandbox image)"
	@echo "make up-boxlite  force BoxLite endpoint-backed stack (api + postgres)"
	@echo "make up-cp       control-plane only (api + postgres), no sandbox provider"
	@echo "make down        stop the stack (PRESERVES the pgdata/workspaces volumes)"
	@echo "make down-v      stop the stack AND drop the volumes (DESTRUCTIVE — data loss)"

up:
	@./scripts/dev-up.sh

up-aio:
	@./scripts/dev-up.sh --aio

up-boxlite:
	@./scripts/dev-up.sh --boxlite

up-cp:
	@./scripts/dev-up.sh --control-plane-only

down:
	@./scripts/dev-down.sh

down-v:
	@./scripts/dev-down.sh -v
