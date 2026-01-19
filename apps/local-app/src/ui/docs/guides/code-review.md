---
title: "Code Review"
description: "Review code changes with inline comments, suggestions, and AI agent collaboration"
slug: "code-review"
category: "guides"
tags: ["reviews", "code-quality", "collaboration"]
---

DevChain's Code Review feature helps you review code changes before committing or after commits are made. It supports inline comments, suggestions, and collaboration with AI agents.

## Do I Need to Review?

Code review is **optional**. The Code Reviewer agent typically handles reviews automatically, identifying issues and suggesting improvements. However, agents aren't perfect. If you spot room for improvement, you can communicate directly with agents (Planner, Coder, etc.) to request changes or fixes during the review process. It's entirely up to you how involved you want to be.

## Interface Overview

The code review interface has three main areas:

### Comment Sidebar (Left Panel)

The sidebar shows a reference list of all comments on the review. Use it to:

- **Browse all comments** at a glance
- **Filter comments** by type: All, File (per-line), or Review (general)
- **Navigate to comments** - click any comment to jump to it in the diff viewer
- **Track pending comments** - comments awaiting agent response are highlighted
- **Add review-level comments** - use the "+" button to add general comments
- **Close the review** - when you're done reviewing

### Review-Level Comments Section

Above the diff viewer, there's a collapsible section for **review-level comments** (comments not tied to a specific file or line). This section:

- Shows all general comments about the overall changes
- Can be expanded/collapsed by clicking the header
- Automatically expands when you navigate to a review-level comment

### Diff Viewer (Main Area)

The diff viewer shows file changes with inline commenting capabilities:

- **Unified or split view** - toggle between viewing modes
- **Click any line** to add a comment at that location
- **Comment indicators** - lines with comments show a badge with the count
- **Expand/collapse hunks** - large unchanged sections can be collapsed

## Ways to Review

### Per-File / Per-Line Comments

Click on a specific line in the diff to add a comment about that particular change. This is useful for:

- Pointing out bugs or issues in specific code
- Suggesting alternative implementations
- Asking questions about why something was done a certain way

### Review-Level Comments

Leave a comment that applies to the entire set of changes (not tied to a specific file or line). This is useful for:

- Overall architectural feedback
- General observations about the approach
- Requesting broader changes across multiple files

## Working with Comments

### Adding Comments

1. **Per-line**: Click on a line number in the diff viewer
2. **Review-level**: Click the "+" button in the comment sidebar header

### Comment Types

When adding a comment, you can choose the type:

- **Comment** - General observation or question
- **Issue** - Something that needs to be fixed
- **Suggestion** - A proposed change (can include code)

### Replying to Comments

Click "Reply" on any comment to add a response. Replies are threaded under the original comment.

### Resolving Comments

When an issue has been addressed:

1. Click the menu (...) on the comment
2. Choose "Resolve" or "Won't Fix"

Resolved comments are moved to the bottom of the list and shown with reduced emphasis.

### Targeting Agents

When adding a comment, you can @mention specific agents to get their attention. Comments targeting agents show a "Pending" indicator until the agent responds.

## Navigation

The sidebar and diff viewer are connected:

- **Click a comment in the sidebar** to scroll to it in the diff viewer
- The target comment is **highlighted** temporarily so you can find it easily
- For comments in collapsed hunks, the hunk automatically expands

## Closing Reviews

When you're finished reviewing, click the "Close Review" button in the comment sidebar. This marks the review as complete and clears it from the active review state.

## Tips

- Use the refresh button to update the working tree diff when files change
- Large files or many untracked files may have their diffs capped for performance
- Panel sizes are remembered between sessions
- Comments persist even when switching between files
- Use filters to focus on specific comment types
- Pending comments (awaiting agent response) appear at the top of lists
