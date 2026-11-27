---
title: 'Chat'
description: 'Communicate with AI agents, understand the development workflow, and keep sessions healthy'
slug: 'chat'
category: 'guides'
tags: ['chat', 'messaging', 'agents', 'workflow']
---

DevChain's `/chat` page is the terminal/session console for communicating with AI agents and coordinating development work. It provides agent lifecycle controls, inline or floating terminals, live terminal input, session transcripts, and session history.

Agent-to-agent messages sent with `devchain_send_message` are routed to terminal sessions and reported through delivery status/diagnostics. `/chat` does not provide durable conversation or thread history. Mobile session Chat, its transcript/history views, and the notification Inbox remain separate retained surfaces.

## Understanding the Development Workflow

Before using Chat, make sure you understand the development flow provided by the template your project uses.

> If you're using the **teams-dev** template, review its workflow diagram at [templates/workflow-diagram](https://devchain.cc/templates/workflow-diagram.html).

DevChain is an **AI-driven system** — agents run the entire development flow and decide their next steps autonomously. The quality of results depends heavily on the LLMs you assign to key roles. Smarter models in planning and review roles lead to better outcomes.

Agents aren't perfect. They can occasionally drift from their instructions, forget context, or get stuck. Understanding the workflow helps you recognize when this happens and guide agents back on track. With a well-configured setup and attentive session management, this is rare.

---

## Insert a Custom Prompt

When an agent's terminal is open inline on the Chat page, select **Prompts** immediately before **Window** to search the active project's Custom prompts. You can also press the physical keyboard shortcut **Alt+Shift+P** while the inline terminal input is focused.

- The picker appears only for an eligible inline terminal. It is not available in detached/floating terminal windows.
- Only prompts classified as **Custom** are shown. Untyped prompts fall back to System and are excluded; global prompts are not included.
- Selecting a prompt inserts its full content at the current caret or replaces the selected text. It **never submits or sends automatically**—review or edit the inserted text, then send it explicitly.

On mobile, live editable chats expose the same **Prompts** action above the composer. Selection inserts into the message draft without sending. The live terminal viewport remains read-only and does not accept prompt text.

---

## Disable and Enable an Agent

Disable an agent to pause it for a while without deleting it. The agent stays on its team.

- Right-click a team member in the agent list and select **Disable**. The item is available for a team member that leads no team and is not the Project Owner.
- An agent that is known to be offline is disabled at once. In every other case a confirmation opens first: Disable stops a running session.
- A disabled agent shows as a dimmed row with a **Disabled** label, after the enabled agents. You cannot open or start it, and its context menu has only **Enable**.
- Other agents and automations do not see a disabled agent, and it gets no messages. Its epics stay assigned and wait until you enable it.
- If the team lead has a running session, it gets a short message when you disable or enable the agent.
- Select **Enable** to bring the agent back. Enable starts no session; start the agent when you need it.

---

## Team Status Dots

A folded team shows one dot per team member after the team name. An unfolded team shows no dots, because its rows are visible. The team lead has no dot, because the lead's row is always visible. A team with no lead shows a dot for each of its agents.

The dots are small, the same size as the live dot in the terminal header.

| Dot              | State                   | Meaning                                                                                                      |
| ---------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| Amber diamond    | Waiting for your answer | The agent's session is open and asks you a question.                                                         |
| Pulsing green    | Working                 | The agent's session is open and busy. It blinks slowly, once every 4 s, like the terminal header's live dot. |
| Dark green       | Idle                    | The agent's session is open and idle. The dot does not pulse.                                                |
| Hollow grey ring | Offline                 | The agent has no session.                                                                                    |

- Hover a dot to see the agent's name and state. For a working agent the tooltip also shows how long it has been busy.
- Click a dot to open that agent. The click does not fold or unfold the team.
- A disabled agent has no dot.
- Only Claude agents report a pending question. The amber dot can appear up to about 10 seconds after the question.

---

## Tips for Maintaining Automated Development

### Respect Agent Roles

Avoid asking agents to perform tasks outside their designated roles — don't ask a planner to write code or a coder to do research. Agents inherit your instructions and will change their behavior accordingly, which can disrupt the workflow.

### Manage Session Health

Avoid overextending agent sessions through repeated context compaction, especially with `Claude Code`. Agents tend to become less effective after multiple compaction cycles as accumulated context degrades. After completing large features, restart agents to refresh their context and restore full instruction adherence.

> DevChain detects when Claude reaches its context limit and runs compaction automatically to renew agent instructions. Make sure `auto-compact` is **disabled** in Claude Code's own settings — DevChain handles this for you.
