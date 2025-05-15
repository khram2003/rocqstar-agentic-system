#!/bin/sh

# path to the executable
filepath="/usr/local/bin/coqpilot-server"

# get current directory
current_dir=$(pwd)
printf "\033[0;32mCreating a shell script at $filepath...\033[0m\n"

# create the bash script
cat > "$filepath" << EOF
#!/bin/bash
run_root=\$(pwd)
cd $current_dir

# Function to check if a port is in use
wait_for_port() {
    local port=\$1
    local timeout=10
    local start_time=\$(date +%s)
    
    printf "\033[0;33mWaiting for port \$port to be available...\033[0m\n"
    while ! nc -z localhost \$port; do
        if [ \$((\$(date +%s) - start_time)) -gt \$timeout ]; then
            printf "\033[0;31mTimeout waiting for port \$port\033[0m\n"
            echo "Killing servers..."
            echo "COQ_SERVER_PID: \$COQ_SERVER_PID"
            echo "MCP_SERVER_PID: \$MCP_SERVER_PID"
            kill \$COQ_SERVER_PID 2>/dev/null
            kill \$MCP_SERVER_PID 2>/dev/null
            exit 1
        fi
        printf "."
        sleep 0.1
    done
    printf "\n\033[0;32mPort \$port is now available!\033[0m\n"
}

# Function to check health of Coq project server
check_coq_health() {
    local response=$(curl -s http://127.0.0.1:8000/rest/document)
    if echo "$response" | grep -q '"projectRoot"'; then
        return 0
    else
        echo "$response"
        return 1

    fi
}

# Function to check health of MCP server
check_mcp_health() {
    local response=$(curl -s http://localhost:3001/sse)
    if echo "$response" | grep -q 'data: /messages?sessionId='; then
        return 0
    else
        return 1
    fi
}

# Cleanup function
cleanup() {
    printf "\n\033[0;32mShutting down servers...\033[0m\n"
    kill \$COQ_SERVER_PID 2>/dev/null
    kill \$MCP_SERVER_PID 2>/dev/null
    exit 0
}

# Set up trap to catch termination signals
trap cleanup SIGINT SIGTERM

# Start both servers in the background
printf "\033[0;32mStarting Coq project server and MCP server...\033[0m\n"
npm run server -- SERVER_RUN_ROOT=\$run_root &
COQ_SERVER_PID=\$!
npm run mcp-server &
MCP_SERVER_PID=\$!

# Wait for both servers to start
printf "\033[0;32mWaiting for servers to start...\033[0m\n"
# wait_for_port 3000
# wait_for_port 3001

# Check server health
printf "\033[0;32mChecking server health...\033[0m\n"
if check_coq_health; then
    printf "\033[0;31mCoq server health check failed\033[0m\n"
    cleanup
    exit 1
fi

if check_mcp_health; then
    printf "\033[0;31mMCP server health check failed\033[0m\n"
    cleanup
    exit 1
fi

printf "\033[0;32mBoth servers are running and healthy!\033[0m\n"
printf "\033[0;33mCoq Project Server: http://localhost:3000\033[0m\n"
printf "\033[0;33mMCP Server: http://localhost:3001\033[0m\n"
printf "\033[0;32mPress Ctrl+C to stop both servers\033[0m\n"

# Keep the script running
wait
EOF

printf "\033[0;32mMaking the script executable...\033[0m\n"
chmod +x $filepath

printf "\e[33mThe command 'coqpilot-server' has been created! \033[0m✅\n"
printf "\033[0;32mNow, you can run 'coqpilot-server' from any location.\033[0m\n"