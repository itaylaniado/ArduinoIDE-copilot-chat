/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { IArduinoCliService } from '../services/arduinoCliService';
import { IBoardContextService } from '../services/boardContextService';
import { ISketchService } from '../services/sketchService';
import { ISerialTelemetryService } from '../services/serialTelemetryService';
import { CopilotCliAgentBridge } from '../orchestrator/copilotCliAgentBridge';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { createServiceIdentifier } from '../../../util/common/services';
import { GitHubDeviceFlowAuth } from '../auth/githubDeviceFlowAuth';
import { DEFAULT_MAIN_CSS, DEFAULT_MAIN_JS } from './webviewAssets';

export interface IArduinoChatViewProvider {
	readonly _serviceBrand: undefined;
}

export const IArduinoChatViewProvider = createServiceIdentifier<IArduinoChatViewProvider>('IArduinoChatViewProvider');

export class ArduinoChatViewProvider extends Disposable implements vscode.WebviewViewProvider, IArduinoChatViewProvider {
	declare _serviceBrand: undefined;
	public static readonly viewType = 'arduinoCopilot.chatView';

	private _view?: vscode.WebviewView;
	private readonly _agentBridge: CopilotCliAgentBridge;

	constructor(
		private readonly extensionUri: vscode.Uri,
		@IArduinoCliService private readonly arduinoCliService: IArduinoCliService,
		@IBoardContextService private readonly boardContextService: IBoardContextService,
		@ISketchService private readonly sketchService: ISketchService,
		@ISerialTelemetryService private readonly serialTelemetryService: ISerialTelemetryService
	) {
		super();
		this._agentBridge = this._register(new CopilotCliAgentBridge(
			this.arduinoCliService,
			this.boardContextService,
			this.sketchService,
			this.serialTelemetryService
		));

		// Pipe streaming events from Agent Bridge to Webview
		this._register(this._agentBridge.onDidReceiveChunk(event => {
			this._view?.webview.postMessage({
				type: 'chunk',
				messageId: event.messageId,
				chunk: event.chunk
			});
		}));

		this._register(this._agentBridge.onDidUpdateToolStatus(event => {
			this._view?.webview.postMessage({
				type: 'toolStatus',
				messageId: event.messageId,
				toolName: event.toolName,
				status: event.status,
				result: event.result
			});
		}));

		this._register(this._agentBridge.onDidEditFile(event => {
			this._view?.webview.postMessage({
				type: 'fileEdited',
				messageId: event.messageId,
				filename: event.filename,
				previousContent: event.previousContent,
				explanation: event.explanation
			});
		}));

		this._register(this.boardContextService.onDidChangeBoard(board => {
			this._view?.webview.postMessage({
				type: 'updateBoardInfo',
				boardName: board.name,
				port: this.boardContextService.getActivePort()
			});
		}));

		this._register(GitHubDeviceFlowAuth.getInstance().onDidChangeSessions(() => {
			const session = GitHubDeviceFlowAuth.getInstance().getCurrentSession();
			this._view?.webview.postMessage({
				type: 'updateAuthStatus',
				signedIn: !!session,
				user: session?.account.label || ''
			});
		}));
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		token: vscode.CancellationToken
	): void {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri]
		};

		webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

		// Handle messages from the Webview
		webviewView.webview.onDidReceiveMessage(async (message) => {
			switch (message.command) {
				case 'sendMessage': {
					await this._agentBridge.sendMessage(message.text, message.replyId);
					break;
				}
				case 'applyToSketch': {
					await this.applyCodeToActiveSketch(message.code);
					break;
				}
				case 'revertEdit': {
					const success = await this.sketchService.revertFileEdit(message.filename, message.previousContent);
					if (success) {
						vscode.window.showInformationMessage(`Copilot changes to ${message.filename} reverted.`);
						this._view?.webview.postMessage({
							type: 'revertResult',
							filename: message.filename,
							success: true
						});
					} else {
						vscode.window.showWarningMessage(`Could not revert changes to ${message.filename}.`);
					}
					break;
				}
				case 'selectBoard': {
					await this.promptSelectBoard();
					break;
				}
				case 'refreshBoard': {
					await this.refreshBoard();
					break;
				}
				case 'signIn': {
					await GitHubDeviceFlowAuth.getInstance().signIn();
					break;
				}
				case 'signOut': {
					await GitHubDeviceFlowAuth.getInstance().signOut();
					break;
				}
				case 'getAuthStatus': {
					const session = GitHubDeviceFlowAuth.getInstance().getCurrentSession();
					this._view?.webview.postMessage({
						type: 'updateAuthStatus',
						signedIn: !!session,
						user: session?.account.label || ''
					});
					break;
				}
			}
		});
	}

	private async applyCodeToActiveSketch(code: string): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			const document = editor.document;
			const fullRange = new vscode.Range(
				document.positionAt(0),
				document.positionAt(document.getText().length)
			);
			await editor.edit(editBuilder => {
				editBuilder.replace(fullRange, code);
			});
			vscode.window.showInformationMessage('Copilot code successfully applied to current sketch.');
			return;
		}

		// If no active editor, try finding main .ino tab
		const tabs = await this.sketchService.getSketchTabs();
		const mainTab = tabs.find(t => t.isMainIno) || tabs[0];
		if (mainTab) {
			const doc = await vscode.workspace.openTextDocument(mainTab.uri);
			const editEditor = await vscode.window.showTextDocument(doc);
			const fullRange = new vscode.Range(
				doc.positionAt(0),
				doc.positionAt(doc.getText().length)
			);
			await editEditor.edit(editBuilder => {
				editBuilder.replace(fullRange, code);
			});
			vscode.window.showInformationMessage(`Copilot code applied to ${mainTab.name}.`);
		} else {
			vscode.window.showWarningMessage('No active Arduino sketch tab found to apply code.');
		}
	}

	private async refreshBoard(): Promise<void> {
		// 1. Re-query IDE API in case IDE changed or finished loading
		await this.boardContextService.attachArduinoApi();

		// 2. Check physical USB detected boards
		try {
			const detected = await this.arduinoCliService.listDetectedBoards();
			if (detected.length > 0) {
				const b = detected[0];
				this.boardContextService.setActiveBoard(b.fqbn);
				if (b.port?.address) {
					this.boardContextService.setActivePort(b.port.address);
				}
			}
		} catch {}

		const board = this.boardContextService.getActiveBoard();
		const port = this.boardContextService.getActivePort();
		this._view?.webview.postMessage({
			type: 'updateBoardInfo',
			boardName: board.name,
			port: port || 'No port'
		});
	}

	private async promptSelectBoard(): Promise<void> {
		interface BoardItem extends vscode.QuickPickItem {
			fqbn: string;
			port?: string;
		}

		const items: BoardItem[] = [];

		// 1. Detected physical USB boards
		try {
			const detected = await this.arduinoCliService.listDetectedBoards();
			for (const d of detected) {
				items.push({
					label: `$(plug) ${d.name}`,
					description: `${d.fqbn} (${d.port.address})`,
					detail: 'Connected via USB port',
					fqbn: d.fqbn,
					port: d.port.address
				});
			}
		} catch {}

		// 2. Installed CLI boards
		try {
			const installed = await this.arduinoCliService.listAllInstalledBoards();
			for (const b of installed) {
				if (!items.some(i => i.fqbn === b.fqbn)) {
					items.push({
						label: `$(circuit-board) ${b.name}`,
						description: b.fqbn,
						detail: 'Installed Core Package',
						fqbn: b.fqbn
					});
				}
			}
		} catch {}

		// 3. Known popular boards as fallback
		const { KNOWN_BOARDS } = await import('../services/boardContextService');
		for (const [fqbn, profile] of Object.entries(KNOWN_BOARDS)) {
			if (!items.some(i => i.fqbn === fqbn)) {
				items.push({
					label: `$(chip) ${profile.name}`,
					description: fqbn,
					detail: `${profile.architecture.toUpperCase()} • ${profile.voltage}V • ${Math.round(profile.flashBytes / 1024)}KB Flash`,
					fqbn: fqbn
				});
			}
		}

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: 'Select Arduino / Embedded Board for Copilot context & verification',
			matchOnDescription: true,
			matchOnDetail: true
		});

		if (selected) {
			this.boardContextService.setActiveBoard(selected.fqbn);
			if (selected.port) {
				this.boardContextService.setActivePort(selected.port);
			}
			const activeBoard = this.boardContextService.getActiveBoard();
			const activePort = this.boardContextService.getActivePort() || 'No port';
			this._view?.webview.postMessage({
				type: 'updateBoardInfo',
				boardName: activeBoard.name,
				port: activePort
			});
			vscode.window.showInformationMessage(`Copilot target board set to ${activeBoard.name} (${selected.fqbn}).`);
		}
	}

	private getHtmlForWebview(_webview: vscode.Webview): string {
		// Use bundled default assets (guaranteed non-empty, immune to path or I/O resolution errors)
		let inlineCss = DEFAULT_MAIN_CSS;
		let inlineJs = DEFAULT_MAIN_JS;

		// Check multiple candidate directories on disk in case updated assets exist
		const candidateDirs = [
			this.extensionUri.fsPath,
			path.join(this.extensionUri.fsPath, 'dist'),
			__dirname,
			path.join(__dirname, 'dist'),
			path.dirname(__dirname),
			path.join(path.dirname(__dirname), 'dist'),
			path.join(this.extensionUri.fsPath, 'src', 'extension', 'arduino', 'webview')
		];

		for (const dir of candidateDirs) {
			const cssPath = path.join(dir, 'main.css');
			try {
				if (fs.existsSync(cssPath)) {
					const content = fs.readFileSync(cssPath, 'utf8');
					if (content && content.length > 0) {
						inlineCss = content;
						break;
					}
				}
			} catch {}
		}

		for (const dir of candidateDirs) {
			const jsPath = path.join(dir, 'main.js');
			try {
				if (fs.existsSync(jsPath)) {
					const content = fs.readFileSync(jsPath, 'utf8');
					if (content && content.length > 0) {
						inlineJs = content;
						break;
					}
				}
			} catch {}
		}

		const board = this.boardContextService.getActiveBoard();
		const port = this.boardContextService.getActivePort() || 'No port';
		const session = GitHubDeviceFlowAuth.getInstance().getCurrentSession();
		const signedIn = !!session;
		const authLabel = signedIn ? `👤 ${session!.account.label}` : '🔑 Sign In';

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Arduino Copilot</title>
	<style>${inlineCss}</style>
</head>
<body>
	<div class="board-banner">
		<div class="board-info">
			<span class="board-chip" id="active-board-chip" title="Click to switch or select target board">${board.name}</span>
			<span class="port-chip" id="active-port-chip">${port}</span>
			<button class="auth-chip ${signedIn ? 'signed-in' : ''}" id="auth-btn" title="GitHub Account Status">
				<span id="auth-label">${authLabel}</span>
			</button>
		</div>
		<button class="refresh-btn" id="refresh-board-btn" title="Refresh Connected Board">↻</button>
	</div>

	<div class="messages-container" id="messages">
		<div class="message-row assistant">
			<div class="message-sender"><span>Arduino Copilot</span></div>
			<div class="message-bubble">
				<p>Hello! I am your <strong>Arduino Copilot</strong>, tuned for physical computing and embedded microcontrollers on <strong>${board.name}</strong>.</p>
				<p>Select a quick action below or ask a question about your sketch!</p>
			</div>
		</div>
	</div>

	<div class="chips-bar">
		<button class="action-chip" data-action="Verify & Compile">⚡ Verify & Compile</button>
		<button class="action-chip" data-action="Fix Errors">🛠️ Fix Errors</button>
		<button class="action-chip" data-action="Check Pinout">📌 Check Pinout</button>
		<button class="action-chip" data-action="Upload Sketch">🚀 Upload</button>
		<button class="action-chip" data-action="Wire Sensor">🔌 Wire Component</button>
	</div>

	<div class="input-container">
		<div class="input-box-wrapper">
			<textarea id="chat-input" rows="1" placeholder="Ask Arduino Copilot... (Enter to send)"></textarea>
			<button class="send-btn" id="send-btn" title="Send">➤</button>
		</div>
	</div>

	<script>${inlineJs}</script>
</body>
</html>`;
	}
}
