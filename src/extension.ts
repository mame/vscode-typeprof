"use strict";

import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient/node";
import * as net from "net";
import * as child_process from "child_process";
import { existsSync } from "fs";

interface Invoking {
  kind: "invoking";
  workspaceFolder: vscode.WorkspaceFolder;
  process: child_process.ChildProcessWithoutNullStreams;
}
interface Running {
  kind: "running";
  workspaceFolder: vscode.WorkspaceFolder;
  client: LanguageClient;
}
type State = Invoking | Running;

const CONFIGURATION_ROOT_SECTION = "typeprof";

let statusBarItem: vscode.StatusBarItem;
function addToggleButton(context: vscode.ExtensionContext) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "typeprof.toggle";
  statusBarItem.text = "TypeProf $(eye)";

  const disposable = vscode.commands.registerCommand("typeprof.toggle",
    (arg0: any, arg1: any, arg2: any, arg3: any) => {
      if (statusBarItem.text == "TypeProf $(eye)") {
        statusBarItem.text = "TypeProf $(eye-closed)";
        vscode.commands.executeCommand("typeprof.disableSignature");
      }
      else {
        statusBarItem.text = "TypeProf $(eye)";
        vscode.commands.executeCommand("typeprof.enableSignature");
      }
    }
  );

  context.subscriptions.push(disposable);
}

function addJumpToRBS(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand("typeprof.jumpToRBS",
    (arg0: any, arg1: any, arg2: any, arg3: any) => {
      const uri0 = vscode.Uri.parse(arg0);
      const pos0 = new vscode.Position(arg1.line, arg1.character);
      const uri1 = vscode.Uri.parse(arg2);
      const pos1 = new vscode.Position(arg3.start.line, arg3.start.character);
      const pos2 = new vscode.Position(arg3.end.line, arg3.end.character);
      const range = new vscode.Range(pos1, pos2);
      const loc = new vscode.Location(uri1, range);
      vscode.commands.executeCommand("editor.action.peekLocations", uri0, pos0, [loc], "peek");
    }
  );

  context.subscriptions.push(disposable);
}

let progressBarItem: vscode.StatusBarItem;
function addJumpToOutputChannel(context: vscode.ExtensionContext) {
  progressBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  progressBarItem.command = 'typeprof.jumpToOutputChannel';

  const disposable = vscode.commands.registerCommand('typeprof.jumpToOutputChannel', () => {
    outputChannel.show();
    progressBarItem.hide();
    showErrorStatusBar();
  });

  context.subscriptions.push(disposable);
}

function showErrorStatusBar() {
  statusBarItem.text = '$(error) TypeProf';
  statusBarItem.command = 'typeprof.jumpToOutputChannel';
  statusBarItem.show();
}

function executeTypeProf(folder: vscode.WorkspaceFolder, arg: String): child_process.ChildProcessWithoutNullStreams {
  const configuration = vscode.workspace.getConfiguration(CONFIGURATION_ROOT_SECTION);
  const customServerPath = configuration.get<string | null>("server.path");
  const cwd = folder.uri.fsPath;

  let cmd: string;
  if (existsSync(`${cwd}/bin/typeprof`)) {
    cmd = "./bin/typeprof";
  }
  else if (customServerPath) {
    cmd = customServerPath;
  }
  else if (existsSync(`${cwd}/Gemfile`)) {
    cmd = "bundle exec typeprof";
  }
  else {
    cmd = "typeprof";
  }
  cmd = cmd + " " + arg;

  const shell = process.env.SHELL;
  let typeprof: child_process.ChildProcessWithoutNullStreams;
  if (shell && (shell.endsWith("bash") || shell.endsWith("zsh") || shell.endsWith("fish"))) {
    const args: string[] = [];
    if (shell.endsWith('zsh')) {
      // As the recommended way, initialization commands for rbenv are written in ".zshrc".
      // However, it's not loaded on the non-interactive shell.
      // Thus, we need to run this command as the interactive shell.
      // FYI: https://zsh.sourceforge.io/Guide/zshguide02.html
      args.push('-i');
    }
    args.push("-l", "-c", cmd);
    typeprof = child_process.spawn(shell, args, { cwd });
  }
  else if (process.platform === "win32") {
    typeprof = child_process.spawn(process.env.SYSTEMROOT + "\\System32\\cmd.exe", ["/c", cmd], { cwd });
  }
  else {
    const cmds = cmd.split(' ')
    typeprof = child_process.spawn(cmds[0], cmds.slice(1), { cwd });
  }

  return typeprof;
}

function getTypeProfVersion(folder: vscode.WorkspaceFolder, callback: (err: Error | null, version: string) => void): child_process.ChildProcessWithoutNullStreams {
  const typeprof = executeTypeProf(folder, "--version");
  let output = "";

  const log = (msg: string) => {
    outputChannel.appendLine("[vscode] " + msg);
    console.info(msg);
  };

  typeprof.stdout?.on("data", out => { output += out; });
  typeprof.stderr?.on("data", (out: Buffer) => {
    const str = ("" + out).trim();
    for (const line of str.split("\n")) {
      log("stderr: " + line);
    }
  });
  typeprof.on("error", e => {
    log(`typeprof is not supported for this folder: ${folder.name}`);
    log(`because: ${e}`);
  });
  typeprof.on("exit", (code) => {
    if (code == 0) {
      const str = output.trim();
      log(`typeprof version: ${str}`)
      const version = /^typeprof (\d+).(\d+).(\d+)$/.exec(str);
      if (version) {
        const major = Number(version[1]);
        const minor = Number(version[2]);
        const _teeny = Number(version[3]);
        if (major >= 1 || (major == 0 && minor >= 20)) {
          callback(null, str);
        }
        else {
          const err = new Error(`typeprof version ${str} is too old; please use 0.20.0 or later for IDE feature`)
          log(err.message);
          callback(err, '');
        }
      }
      else {
        const err = new Error(`typeprof --version showed unknown message`);
        log(err.message);
        callback(err, '');
      }
    }
    else {
      const err = new Error(`failed to invoke typeprof: error code ${code}`);
      log(err.message);
      callback(err, '');
    }
    typeprof.kill()
  });
  return typeprof;
}

function getTypeProfStream(folder: vscode.WorkspaceFolder, error: (msg: string) => void):
  Promise<{ host: string; port: number; pid: number; stop: () => void }>
{
  return new Promise((resolve, reject) => {
    const typeprof = executeTypeProf(folder, "--lsp");

    let buffer = "";
    typeprof.stdout.on("data", (data) => {
      buffer += data;
      try {
        const json = JSON.parse(data);
        json["stop"] = () => typeprof.kill("SIGINT");
        resolve(json);
      } catch (err) {}
    });

    let err = "";
    typeprof.stderr.on("data", (data) => {
      err += data;
      while (true) {
        const i = err.indexOf("\n");
        if (i < 0) break;
        error(err.slice(0, i));
        err = err.slice(i + 1);
      }
    });

    typeprof.on("exit", (code) => reject(`error code ${code}`));
  });
}

function invokeTypeProf(folder: vscode.WorkspaceFolder): LanguageClient {
  let client: LanguageClient;

  const reportError = (msg: string) => client.info(msg);

  const serverOptions: ServerOptions = async () => {
    const { host, port, stop } = await getTypeProfStream(folder, reportError);
    const socket: net.Socket = net.createConnection(port, host);
    socket.on("close", (_had_error) => stop());

    return {
      reader: socket,
      writer: socket,
    };
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "ruby" },
      { scheme: "file", language: "rbs" },
    ],
    outputChannel,
    synchronize: {
      fileEvents:
        vscode.workspace.createFileSystemWatcher("{**/*.rb,**/*.rbs}"),
    },
  };

  client = new LanguageClient("Ruby TypeProf", serverOptions, clientOptions);

  return client;
}

const clientSessions: Map<vscode.WorkspaceFolder, State> = new Map();
const timeoutSec = 10000;

function startTypeProf(folder: vscode.WorkspaceFolder) {
  const showStatus = (msg: string) => {
    outputChannel.appendLine("[vscode] " + msg);
    progressBarItem.text = `$(sync~spin) ${msg}`;
  }
  showStatus("Try to start TypeProf for IDE");

  progressBarItem.show();
  const typeprof = getTypeProfVersion(folder, (err, version) => {
    if (err !== null) {
      showStatus(`Ruby TypeProf is not configured`);
      showFailedStatus();
      clientSessions.delete(folder);
      return;
    }
    showStatus(`Starting Ruby TypeProf (${version})...`);
    const client = invokeTypeProf(folder);
    client.onReady()
      .then(() => {
        showStatus("Ruby TypeProf is running");
      })
      .catch((e: any) => {
        showStatus(`Failed to start Ruby TypeProf: ${e}`);
        showFailedStatus();
        return;
      });
    progressBarItem.hide();
    statusBarItem.show();
    client.start();
    clientSessions.set(folder, { kind: "running", workspaceFolder: folder, client });
  });

  clientSessions.set(folder, { kind: "invoking", workspaceFolder: folder, process: typeprof });
}

function showFailedStatus() {
  setTimeout(() => {
    progressBarItem.hide();
    showErrorStatusBar();
  }, timeoutSec);
}

function stopTypeProf(state: State) {
  switch (state.kind) {
  case "invoking":
    state.process.kill();

    break;
  case "running":
    state.client.stop();
    break;
  }
  clientSessions.delete(state.workspaceFolder);
}

function restartTypeProf() {
  if (!vscode.workspace.workspaceFolders) return;

  stopAllSessions();
  for (const folder of vscode.workspace.workspaceFolders) {
    if (folder.uri.scheme === "file") {
      let state = clientSessions.get(folder);
      if (state) stopTypeProf(state);
      startTypeProf(folder);
      break;
    }
  }
}

function ensureTypeProf() {
  if (!vscode.workspace.workspaceFolders) return;

  const activeFolders = new Set(vscode.workspace.workspaceFolders);

  clientSessions.forEach((state) => {
    if (!activeFolders.has(state.workspaceFolder)) {
      stopTypeProf(state);
    }
  });

  for (const folder of activeFolders) {
    if (folder.uri.scheme === "file" && !clientSessions.has(folder)) {
      startTypeProf(folder);
      break;
    }
  }
}

function addRestartCommand(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand("typeprof.restart", () => {
    progressBarItem.hide();
    statusBarItem.hide();
    outputChannel.clear();
    restartTypeProf();
  });
  context.subscriptions.push(disposable);
}

let outputChannel: vscode.OutputChannel;
export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("Ruby TypeProf");
  addToggleButton(context);
  addJumpToOutputChannel(context);
  addJumpToRBS(context);
  addRestartCommand(context)
  ensureTypeProf();
}

function stopAllSessions() {
  clientSessions.forEach((state) => {
    stopTypeProf(state);
  });
}

export function deactivate() {
  progressBarItem.dispose();
  statusBarItem.dispose();
  stopAllSessions();
}
