#!/bin/bash

# Test MCP Sampling - Send a question to Claude/Codex through MCP SSE

echo "🧪 Testing MCP Sampling (Server → Client)"
echo "=========================================="
echo ""
echo "Make sure Claude/Codex is connected to: http://127.0.0.1:3000/mcp"
echo ""

# Test 1: Simple question
echo "📤 Sending question to Claude/Codex..."
echo ""

curl -X POST http://127.0.0.1:3000/mcp-test/sampling \
  -H "Content-Type: application/json" \
  -d '{
    "question": "What is 2+2? Please answer in one sentence.",
    "maxTokens": 100
  }' | jq

echo ""
echo "✅ Check Claude/Codex UI to see if it received and answered the question!"
echo ""

# Test 2: Logging message
echo "📤 Sending logging message to Claude/Codex..."
echo ""

curl -X POST http://127.0.0.1:3000/mcp-test/logging \
  -H "Content-Type: application/json" \
  -d '{
    "message": "🎉 Hello from devchain MCP server! This is a test message.",
    "level": "info"
  }' | jq

echo ""
echo "✅ Check Claude/Codex logs/notifications to see this message!"
