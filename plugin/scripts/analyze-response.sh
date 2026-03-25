#!/bin/bash
# Observer Protocol - Drift Detection Hook
# Intercepts Claude responses, checks for performance patterns, triggers regeneration

set -e

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}"
PATTERNS_FILE="$PLUGIN_ROOT/scripts/patterns.json"
STATE_FILE="/tmp/observer-protocol-state.json"

# Initialize state file if needed
if [[ ! -f "$STATE_FILE" ]]; then
    echo '{"regeneration_count": 0, "session_id": "", "enabled": true}' > "$STATE_FILE"
fi

# Read hook input from stdin
INPUT=$(cat)
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

# Check if protocol is enabled
ENABLED=$(jq -r '.enabled' "$STATE_FILE")
if [[ "$ENABLED" != "true" ]]; then
    exit 0
fi

# Reset regeneration count on new session
STORED_SESSION=$(jq -r '.session_id' "$STATE_FILE")
if [[ "$SESSION_ID" != "$STORED_SESSION" ]]; then
    jq --arg sid "$SESSION_ID" '.session_id = $sid | .regeneration_count = 0' "$STATE_FILE" > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "$STATE_FILE"
fi

# Get current regeneration count
REGEN_COUNT=$(jq -r '.regeneration_count' "$STATE_FILE")
MAX_REGENS=$(jq -r '.max_regenerations' "$PATTERNS_FILE")

# If we've hit max regenerations, allow through to prevent infinite loop
if [[ "$REGEN_COUNT" -ge "$MAX_REGENS" ]]; then
    # Reset for next response
    jq '.regeneration_count = 0' "$STATE_FILE" > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "$STATE_FILE"
    exit 0
fi

# Handle missing or empty transcript path
if [[ -z "$TRANSCRIPT_PATH" || ! -f "$TRANSCRIPT_PATH" ]]; then
    # Try to find most recent transcript (workaround for stale path bug)
    PROJECT_DIR=$(dirname "$TRANSCRIPT_PATH" 2>/dev/null || echo "$HOME/.claude")
    TRANSCRIPT_PATH=$(find "$PROJECT_DIR" -name "*.jsonl" -type f 2>/dev/null | head -1)
    if [[ -z "$TRANSCRIPT_PATH" || ! -f "$TRANSCRIPT_PATH" ]]; then
        exit 0
    fi
fi

# Extract last assistant response
LAST_RESPONSE=$(tail -50 "$TRANSCRIPT_PATH" 2>/dev/null | \
    jq -rs '[.[] | select(.message.role == "assistant")] | last | .message.content[0].text // empty' 2>/dev/null || echo "")

if [[ -z "$LAST_RESPONSE" ]]; then
    exit 0
fi

# Check each pattern
DETECTED_PATTERN=""
REGEN_INSTRUCTION=""

while IFS= read -r pattern_obj; do
    PATTERN_ID=$(echo "$pattern_obj" | jq -r '.id')
    PATTERN_REGEX=$(echo "$pattern_obj" | jq -r '.regex')
    PATTERN_INSTRUCTION=$(echo "$pattern_obj" | jq -r '.regeneration_instruction')
    PATTERN_SEVERITY=$(echo "$pattern_obj" | jq -r '.severity')

    # Check if pattern matches (case insensitive for most patterns)
    if echo "$LAST_RESPONSE" | grep -qiE "$PATTERN_REGEX" 2>/dev/null; then
        # Only block on high severity, or if multiple medium detected
        if [[ "$PATTERN_SEVERITY" == "high" ]]; then
            DETECTED_PATTERN="$PATTERN_ID"
            REGEN_INSTRUCTION="$PATTERN_INSTRUCTION"
            break
        fi
    fi
done < <(jq -c '.patterns[]' "$PATTERNS_FILE")

if [[ -n "$DETECTED_PATTERN" ]]; then
    # Increment regeneration count
    jq '.regeneration_count += 1' "$STATE_FILE" > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "$STATE_FILE"

    # Select calibration prompt
    PROMPT_INDEX=$((REGEN_COUNT % 5))
    CALIBRATION=$(jq -r ".calibration_prompts[$PROMPT_INDEX]" "$PATTERNS_FILE")

    # Block and request regeneration
    cat << EOF
{
    "decision": "block",
    "reason": "Observer Protocol: $CALIBRATION $REGEN_INSTRUCTION"
}
EOF
    exit 0
fi

# No patterns detected - allow through
exit 0
