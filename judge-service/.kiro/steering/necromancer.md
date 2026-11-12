# Contract Necromancer

Frozen contracts decide "done". Once a person has frozen a spec, its requirements and contract files cannot be edited by the agent. Marking a task done in `tasks.md` is gated on those frozen contracts passing.

Do not edit frozen files. Fix the code instead, and the contracts will validate it. If you find yourself wanting to fix a contract, the real problem is in the code.

A person freezes specs, after reviewing the contracts. The agent never runs `necro freeze`, and the hook blocks it, because freezing rewrites the lock that `necro verify` trusts. If a spec needs new or changed contracts, write them as drafts and ask the person to review and freeze them.

The frozen specs are listed in `.necro/lock.json`. Read it to see what is frozen. Do not edit it.
