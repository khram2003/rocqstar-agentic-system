# RocqStar Agentic System
### Rocq Server + MCP Server + RocqStar Agent 
**This is a fork of the [CoqPilot](https://github.com/JetBrains-Research/coqpilot/) repository, as we re-use parts of its infrastructure and build our solution on top of several of its parts. Authors of this repository are in no way connected to the authors of CoqPilot repository**

A lightweight pair of services that expose a **Model Context Protocol (MCP)** interface around Rocq’s `coq-lsp`, making it simple for autonomous or human-in-the-loop agents (e.g. the _RocqStar_ agent described in our paper) to _check_, _debug_ and _drive_ Rocq proofs programmatically.


Quick overview of the relations:

| Layer | What it does |
|-------|--------------|
| **coq-lsp** | Incremental checking, goal & hover info, error recovery, [coq-lsp](https://github.com/ejgallego/coq-lsp), is not a part of this repo, but is used by the Rocq interaction server |
| **Rocq interaction server** | Thin REST facade exposing a “toolbox” of proof-centric endpoints (`/check`, `/prefix`, `/context`, …) |
| **MCP wrapper** | Implements the Model Context Protocol, mapping MCP “tool calls” onto the REST facade |

## Requirements

* `coq-lsp` version `0.2.2+8.19` is currently required to run the server.

## Coq-LSP installation

To run the servers, you must install a `coq-lsp` server. Depending on the system used in your project, you should install it using `opam` or `nix`. A well-configured `nix` project should have the `coq-lsp` server installed as a dependency. To install `coq-lsp` using `opam`, you can use the following commands: 
```bash
opam pin add coq-lsp 0.2.2+8.19
opam install coq-lsp
```
For more information on how to install `coq-lsp` please refer to [coq-lsp](https://github.com/ejgallego/coq-lsp). 

## Requirements

* `coq-lsp` version `0.2.2+8.19` is currently required to run the extension.

## Installation

### Coq-LSP installation

To run the extension, you must install a `coq-lsp` server. Depending on the system used in your project, you should install it using `opam` or `nix`. A well-configured `nix` project should have the `coq-lsp` server installed as a dependency. To install `coq-lsp` using `opam`, you can use the following commands: 
```bash
opam pin add coq-lsp 0.2.2+8.19
opam install coq-lsp
```
For more information on how to install `coq-lsp` please refer to [coq-lsp](https://github.com/ejgallego/coq-lsp). 



### Building locally

To build the servers locally, you'll need Node.js installed. The recommended way to manage Node.js versions is by using `nvm`. From the root directory, execute:
```bash
nvm use
```
If you prefer not to use `nvm`, ensure you install the Node.js version specified in the [`.nvmrc`](.nvmrc) file by any other method you prefer.

Once Node.js is installed, the remaining setup will be handled by the `npm` package manager. Run the following commands:
```bash
npm install
npm run compile
```


## Local MCP Server and Coq project Server


To run both the MCP server and the Coq project server you need to hit: 
```sh
npm run server
```
This will start the Rocq project server on the `localhost:3000` and the MCP server on the `localhost:3001`. The API documentation is available at `http://localhost:8000/docs/`.

As we want to run the server from any place in the system, and run it from the Coq project root, we need to add the executable to the system path. On Linux/MacOS, you can run: 
```sh
chmod +x scripts/setup_server.sh
sudo ./scripts/setup_server.sh
```

Then you would be able to run the server from any place in the system by typing `rocq-servers`.

* IMPORTANT: `rocq-servers` command should be run from the root of the Coq project, e.g. dataset/imm. During the experiments, we used `imm` project built with `nix`. Please refer to the [imm](https://github.com/weakmemory/imm) repository for more information on how to build the project with `nix`. Please, make sure that you have added `coqPackages.coq-lsp.override.version = "0.2.2+8.19";` to `bundles."8.19"` in the [config.nix](https://github.com/weakmemory/imm/blob/master/.nix/config.nix) file. Also, make sure that you you first run `nix-shell` in `dataset/imm` directory and then run `rocq-servers` from there.

The code and README for agent logic can be found in `rocqstar-agent` folder.