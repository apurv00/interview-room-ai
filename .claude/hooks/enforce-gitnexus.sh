#!/bin/bash

# PreToolUse hook: blocks Edit/Write on source files unless GitNexus
# was queried earlier in the session (indicated by a marker file).
#
# The marker is created by the PostToolUse hook on Bash when the command
# contains "gitnexus cypher" or "gitnexus query".

input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name // empty')

# Only gate Edit and Write tools
if [[ "$tool_name" != "Edit" && "$tool_name" != "Write" ]]; then
  exit 0
fi

# Check if the target file is a source file
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')
if [[ -z "$file_path" ]]; then
  exit 0
fi

# Allow editing plan files, hooks, and settings (non-source)
if [[ "$file_path" == *".claude/"* ]]; then
  exit 0
fi

# Allow if not in the project directory
project_dir="/home/user/interview-room-ai"
if [[ "$file_path" != "$project_dir"* ]]; then
  exit 0
fi

# Check for the GitNexus trace marker (any marker created in the last 60 min)
recent_marker=$(find /tmp -maxdepth 1 -name ".gitnexus-traced-*" -mmin -60 2>/dev/null | head -1)

if [[ -z "$recent_marker" ]]; then
  echo "BLOCKED: You must run GitNexus (npx gitnexus cypher/query) to trace the execution flow BEFORE editing source files. This is required by CLAUDE.md. Run the trace first, then retry your edit." >&2
  exit 2
fi

exit 0
