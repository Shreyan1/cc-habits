# The cc-habits Philosophy

This is a living document. It reflects what we believe today, and we expect it to
grow and change as we learn more from the people who use cc-habits. If something
here stops being true, we will change it in the open rather than pretend it still holds.

## The problem we care about

AI coding agents are trained on the whole internet, so they write the average of all
code ever written. They do not know your style. Every developer carries thousands of
small decisions: how you name things, how you handle errors, which abstractions you
reach for, what you would never do. The model cannot see any of that, so you end up
correcting the same things over and over, or hand writing a CLAUDE.md or AGENTS.md
and keeping it up to date by yourself.

cc-habits exists to close that gap quietly. It watches how you actually code, learns
your habits over time, and makes every AI tool you use remember them, without you
having to do the work.

## What we are building

One developer memory layer that works across the tools you already use: Claude Code,
Cursor, Codex, Gemini, Kimi, Cline, and any plain Git workflow. Not a feature inside
one platform, but the neutral layer that sits between all of them. The more AI coding
tools there are, the more useful a single memory that spans all of them becomes.

## What we believe, for now

These are our principles, roughly in the order we lean on them when a decision is hard.

1. Quality first. If a feature cannot be flawless, it does not ship yet. We would
   rather do three things perfectly than ten things halfway.
2. Reliability you can see. It should work every time, and you should be able to
   verify that it worked. We try to show proof, not ask for trust.
3. Minimal friction. Setup should feel as natural as `git init`. We do not want you
   to buy or manage anything extra just to get started.
4. Transparency. Your habits live in plain files on your own disk. We try to make it
   obvious what was captured, what was learned, and what gets sent where.
5. User first. We optimize for what you feel as a developer, not for what is easiest
   for us to build.

## What we will not do

- No telemetry, and no cc-habits servers. Your profile stays on your machine.
- No lock-in. Everything is a plain file you can read, edit, export, or delete.
- No half-working features dressed up to look finished. If something is experimental,
  we say so.
- Nothing leaves your machine except the diffs you choose to send to the LLM provider
  you pick. With a local model through Ollama, nothing leaves at all.

## How we ship

We ship a small, solid core and grow it in the open. When something is not ready to be
reliable, we keep it clearly marked as experimental instead of presenting it as done.
We expect to get some of this wrong, and we would rather correct it honestly than
defend it. Depth over breadth, every release.
