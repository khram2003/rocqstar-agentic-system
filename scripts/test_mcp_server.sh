#!/bin/bash

# Function to check if a port is in use
wait_for_port() {
    local port=$1
    local timeout=10
    local start_time=$(date +%s)
    
    while ! nc -z localhost $port; do
        if [ $(($(date +%s) - start_time)) -gt $timeout ]; then
            echo "Timeout waiting for port $port"
            exit 1
        fi
        sleep 0.1
    done
}

# Cleanup function
cleanup() {
    echo "Cleaning up..."
    kill $COQ_SERVER_PID 2>/dev/null
    kill $MCP_SERVER_PID 2>/dev/null
    exit 0
}

# Set up trap to catch termination signals
trap cleanup SIGINT SIGTERM

# Start the Coq project server in the background
echo "Starting Coq project server..."
npm run server &
COQ_SERVER_PID=$!

# Wait for the Coq server to start
echo "Waiting for Coq server to start..."
wait_for_port 3000

# Start the MCP server in the background
echo "Starting MCP server..."
npm run mcp-server &
MCP_SERVER_PID=$!

# Wait for the MCP server to start
echo "Waiting for MCP server to start..."
wait_for_port 3001

# Test the MCP server connection
echo "Testing MCP server connection..."
response=$(curl -s -X POST http://localhost:3001/messages \
    -H "Content-Type: application/json" \
    -d '{
        "sessionId": "test-session",
        "tool": "test_connection",
        "parameters": {}
    }')

# Check if the response contains the expected message
if [[ $response == *"Connection successful"* ]]; then
    echo "✅ MCP server test passed! Server is responding correctly."
    echo "Response: $response"
else
    echo "❌ MCP server test failed! Unexpected response:"
    echo "$response"
    cleanup
    exit 1
fi

# Test the Coq project server connection
echo "Testing Coq project server connection..."
coq_response=$(curl -s http://localhost:3000/document)

if [[ $coq_response == *"projectRoot"* ]]; then
    echo "✅ Coq project server test passed! Server is responding correctly."
    echo "Response: $coq_response"
else
    echo "❌ Coq project server test failed! Unexpected response:"
    echo "$coq_response"
    cleanup
    exit 1
fi

echo "Both servers are running and responding correctly!"
echo "Coq Project Server: http://localhost:3000"
echo "MCP Server: http://localhost:3001"
echo "Press Ctrl+C to stop both servers"

# Keep the script running
wait 