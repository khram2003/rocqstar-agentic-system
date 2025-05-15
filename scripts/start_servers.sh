#!/bin/bash

# Function to kill process and all its children
kill_process_tree() {
    local pid=$1
    if [ -n "$pid" ]; then
        # Kill the process and all its children
        pkill -P $pid || true
        kill $pid 2>/dev/null || true
        # Wait a bit for processes to terminate
        sleep 2
    fi
}

# Function to check if a port is in use
wait_for_port() {
    local port=$1
    local timeout=10
    local start_time=$(date +%s)
    
    while ! nc -z localhost $port; do
        if [ $(($(date +%s) - start_time)) -gt $timeout ]; then
            echo "Timeout waiting for port $port"
            return 1
        fi
        sleep 1
    done
    return 0
}

# Function to check Coq server health
check_coq_health() {
    curl -s http://localhost:3000/document > /dev/null
    return $?
}

# Function to check MCP server health
check_mcp_health() {
    curl -s -X POST http://localhost:3001/messages -H "Content-Type: application/json" \
         -d '{"type":"test_connection"}' | grep -q "Connection successful"
    return $?
}

# Cleanup function
cleanup() {
    echo "Shutting down servers..."
    # Kill the main processes and all their children
    kill_process_tree $COQ_PID
    kill_process_tree $MCP_PID
    exit 0
}

# Set trap for cleanup
trap cleanup SIGINT SIGTERM

# Start Coq project server
echo "Starting Coq project server..."
npm run coq-server &
COQ_PID=$!

# Wait for Coq server to be ready
echo "Waiting for Coq server to be ready..."
if ! wait_for_port 3000; then
    echo "Coq server failed to start"
    kill_process_tree $COQ_PID
    exit 1
fi

# Check Coq server health
if ! check_coq_health; then
    echo "Coq server health check failed"
    kill_process_tree $COQ_PID
    exit 1
fi

# Start MCP server
echo "Starting MCP server..."
npm run mcp-server &
MCP_PID=$!

# Wait for MCP server to be ready
echo "Waiting for MCP server to be ready..."
if ! wait_for_port 3001; then
    echo "MCP server failed to start"
    kill_process_tree $COQ_PID
    kill_process_tree $MCP_PID
    exit 1
fi

# Check MCP server health
if ! check_mcp_health; then
    echo "MCP server health check failed"
    kill_process_tree $COQ_PID
    kill_process_tree $MCP_PID
    exit 1
fi

echo "Both servers are running:"
echo "Coq Project Server: http://localhost:3000"
echo "MCP Server: http://localhost:3001"

# Set timeout for the entire script
TIMEOUT=300  # 5 minutes
(
    sleep $TIMEOUT
    echo "Timeout reached after $TIMEOUT seconds"
    cleanup
) &
TIMEOUT_PID=$!

# Wait for either server to exit or timeout
wait -n $COQ_PID $MCP_PID $TIMEOUT_PID
cleanup 