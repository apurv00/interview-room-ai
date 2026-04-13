#!/bin/bash

# PostToolUse hook on Bash: creates a marker file when GitNexus
# cypher/query/augment commands are run, so the PreToolUse hook
# knows the execution flow was traced before edits.

input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name // empty')

if [[ "$tool_name" != "Bash" ]]; then
  exit 0
fi

command=$(echo "$input" | jq -r '.tool_input.command // empty')

# Check if the command ran a GitNexus trace command
if echo "$command" | grep -qE 'gitnexus\s+(cypher|query|augment)'; then
  touch "/tmp/.gitnexus-traced-$(date +%s)"
fi

exit 0
