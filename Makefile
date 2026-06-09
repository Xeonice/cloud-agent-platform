# Local one-click dev (local-one-click-dev). The logic lives in scripts/dev-*.sh;
# these targets are just memorable entry points. `make up` takes a freshly-cloned
# repo to a running + login-able stack with a single command.
.PHONY: help up up-cp down down-v

help:
	@echo "make up      bootstrap apps/api/.env (if absent) + build & start the full stack,"
	@echo "             then wait for /health and print the local auth token"
	@echo "make up-cp   control-plane only (api + postgres); skips the heavy amd64 sandbox build"
	@echo "make down    stop the stack (PRESERVES the pgdata/workspaces volumes)"
	@echo "make down-v  stop the stack AND drop the volumes (DESTRUCTIVE — data loss)"

up:
	@./scripts/dev-up.sh

up-cp:
	@./scripts/dev-up.sh --control-plane-only

down:
	@./scripts/dev-down.sh

down-v:
	@./scripts/dev-down.sh -v
