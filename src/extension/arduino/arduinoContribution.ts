/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IExtensionContribution } from '../common/contributions';
import { Disposable } from '../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../util/vs/platform/instantiation/common/instantiation';
import { IArduinoCliService, ArduinoCliService } from './services/arduinoCliService';
import { IBoardContextService, BoardContextService } from './services/boardContextService';
import { ISketchService, SketchService } from './services/sketchService';
import { ISerialTelemetryService, SerialTelemetryService } from './services/serialTelemetryService';
import { ArduinoChatViewProvider } from './webview/arduinoChatViewProvider';
import { IVSCodeExtensionContext } from '../../platform/extContext/common/extensionContext';
import { GitHubDeviceFlowAuth } from './auth/githubDeviceFlowAuth';

export class ArduinoContribution extends Disposable implements IExtensionContribution {
	readonly id = 'arduinoContribution';

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IArduinoCliService private readonly arduinoCliService: IArduinoCliService,
		@IBoardContextService private readonly boardContextService: IBoardContextService,
		@ISketchService private readonly sketchService: ISketchService,
		@ISerialTelemetryService private readonly serialTelemetryService: ISerialTelemetryService,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext
	) {
		super();
		this.registerViewsAndCommands();
	}

	private registerViewsAndCommands(): void {
		const extensionUri = this.extensionContext?.extensionUri ||
			vscode.extensions.getExtension('GitHub.copilot-chat')?.extensionUri ||
			vscode.Uri.file(path.dirname(__dirname));

		const chatProvider = this.instantiationService.createInstance(
			ArduinoChatViewProvider,
			extensionUri
		);

		// Register the WebviewViewProvider for Arduino IDE 2.x
		this._register(
			vscode.window.registerWebviewViewProvider(
				ArduinoChatViewProvider.viewType,
				chatProvider,
				{ webviewOptions: { retainContextWhenHidden: true } }
			)
		);

		// Register Arduino Copilot Commands
		this._register(
			vscode.commands.registerCommand('arduinoCopilot.openChat', async () => {
				await vscode.commands.executeCommand(`${ArduinoChatViewProvider.viewType}.focus`);
			})
		);

		this._register(
			vscode.commands.registerCommand('arduinoCopilot.compile', async () => {
				const activeSketch = this.sketchService.getActiveSketchFolder();
				const activeBoard = this.boardContextService.getActiveBoard();
				if (!activeSketch) {
					vscode.window.showWarningMessage('No active Arduino sketch folder found.');
					return;
				}

				vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: `Compiling sketch for ${activeBoard.name}...`,
					cancellable: false
				}, async () => {
					const res = await this.arduinoCliService.compile(activeSketch, activeBoard.fqbn);
					if (res.success) {
						vscode.window.showInformationMessage(`Compilation SUCCESS for ${activeBoard.name}!`);
					} else {
						vscode.window.showErrorMessage(`Compilation FAILED. Open Arduino Copilot to fix.`);
					}
				});
			})
		);

		this._register(
			vscode.commands.registerCommand('arduinoCopilot.upload', async () => {
				const activeSketch = this.sketchService.getActiveSketchFolder();
				const activeBoard = this.boardContextService.getActiveBoard();
				const port = this.boardContextService.getActivePort();
				if (!activeSketch) {
					vscode.window.showWarningMessage('No active Arduino sketch folder found.');
					return;
				}
				if (!port) {
					vscode.window.showWarningMessage('No port selected for upload.');
					return;
				}

				vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: `Uploading to ${activeBoard.name} on ${port}...`,
					cancellable: false
				}, async () => {
					const res = await this.arduinoCliService.upload(activeSketch, activeBoard.fqbn, port);
					if (res.success) {
						vscode.window.showInformationMessage('Upload SUCCESS!');
					} else {
						vscode.window.showErrorMessage(`Upload FAILED: ${res.error || 'Unknown error'}`);
					}
				});
			})
		);

		// Authentication Commands (GitHub Device Flow)
		const auth = GitHubDeviceFlowAuth.getInstance();

		this._register(
			vscode.commands.registerCommand('arduinoCopilot.signIn', async () => {
				await auth.signIn();
			})
		);
		this._register(
			vscode.commands.registerCommand('copilot.signIn', async () => {
				await auth.signIn();
			})
		);

		this._register(
			vscode.commands.registerCommand('arduinoCopilot.signOut', async () => {
				await auth.signOut();
			})
		);
		this._register(
			vscode.commands.registerCommand('copilot.signOut', async () => {
				await auth.signOut();
			})
		);

		this._register(
			vscode.commands.registerCommand('arduinoCopilot.authStatus', async () => {
				const session = auth.getCurrentSession();
				if (session) {
					vscode.window.showInformationMessage(`Signed in to GitHub Copilot as ${session.account.label}`);
				} else {
					const signInOpt = 'Sign In';
					const pick = await vscode.window.showWarningMessage('Not signed in to GitHub Copilot.', signInOpt);
					if (pick === signInOpt) {
						await auth.signIn();
					}
				}
			})
		);
	}
}
