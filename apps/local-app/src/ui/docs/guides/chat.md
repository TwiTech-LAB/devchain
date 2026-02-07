---
title: "Chat"
description: "Communicate with AI agents, understand the development workflow, and keep sessions healthy"
slug: "chat"
category: "guides"
tags: ["chat", "messaging", "agents", "workflow"]
---

DevChain's Chat page is your primary interface for communicating with AI agents and coordinating development work.

## Understanding the Development Workflow

Before using Chat, make sure you understand the development flow provided by the template your project uses.

> If you're using the **dev-loop/claude-codex-advanced** (or the older variant) template, review its workflow diagram at [templates/workflow-diagram](https://devchain.twitechlab.com/templates/workflow-diagram.html).

DevChain is an **AI-driven system** — agents run the entire development flow and decide their next steps autonomously. The quality of results depends heavily on the LLMs you assign to key roles. Smarter models in planning and review roles lead to better outcomes.

Agents aren't perfect. They can occasionally drift from their instructions, forget context, or get stuck. Understanding the workflow helps you recognize when this happens and guide agents back on track. With a well-configured setup and attentive session management, this is rare.

---

## Tips for Maintaining Automated Development

### Respect Agent Roles

Avoid asking agents to perform tasks outside their designated roles — don't ask a planner to write code or a coder to do research. Agents inherit your instructions and will change their behavior accordingly, which can disrupt the workflow.

### Manage Session Health

Avoid overextending agent sessions through repeated context compaction, especially with `Claude Code`. Agents tend to become less effective after multiple compaction cycles as accumulated context degrades. After completing large features, restart agents to refresh their context and restore full instruction adherence.

> DevChain detects when Claude reaches its context limit and runs compaction automatically to renew agent instructions. Make sure `auto-compact` is **disabled** in Claude Code's own settings — DevChain handles this for you.
