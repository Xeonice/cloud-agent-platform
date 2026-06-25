# @cap/sandbox-scheduler

Capability-based provider scheduling for local and cloud sandbox backends.

This package owns Sandbank-style provider candidate selection: providers declare
capabilities, callers declare the operation capabilities they need, and the
scheduler selects a compatible candidate by priority and location preference.

It depends only on `@cap/sandbox-core`.
