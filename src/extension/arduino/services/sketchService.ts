/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { createServiceIdentifier } from '../../../util/common/services';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

export interface SketchTab {
	name: string;
	uri: vscode.Uri;
	content: string;
	isMainIno: boolean;
}

export interface SketchAnalysisIssue {
	type: 'blocking_delay' | 'missing_f_macro' | 'string_heap_risk' | 'missing_volatile_isr' | 'missing_pinmode';
	severity: 'warning' | 'info' | 'error';
	message: string;
	line?: number;
	recommendation: string;
}

export interface FileEditResult {
	success: boolean;
	originalContent: string;
	filename: string;
	uri?: vscode.Uri;
	error?: string;
}

export interface ISketchService {
	readonly _serviceBrand: undefined;
	getActiveSketchFolder(): string | undefined;
	getSketchTabs(): Promise<SketchTab[]>;
	getCombinedSketchCode(): Promise<string>;
	analyzeSketch(code: string, architecture?: string): SketchAnalysisIssue[];
	applyFileEdit(filename: string, newContent: string): Promise<FileEditResult>;
	revertFileEdit(filename: string, previousContent?: string): Promise<boolean>;
}

export const ISketchService = createServiceIdentifier<ISketchService>('ISketchService');

export class SketchService extends Disposable implements ISketchService {
	declare _serviceBrand: undefined;

	private readonly _editHistory: Map<string, string[]> = new Map();

	constructor() {
		super();
	}

	public getActiveSketchFolder(): string | undefined {
		const activeEditor = vscode.window.activeTextEditor;
		if (activeEditor) {
			const filePath = activeEditor.document.uri.fsPath;
			if (filePath.endsWith('.ino') || filePath.endsWith('.cpp') || filePath.endsWith('.h')) {
				return path.dirname(filePath);
			}
		}

		// Fallback to workspace folder
		const folders = vscode.workspace.workspaceFolders;
		if (folders && folders.length > 0) {
			return folders[0].uri.fsPath;
		}

		return undefined;
	}

	public async getSketchTabs(): Promise<SketchTab[]> {
		const folder = this.getActiveSketchFolder();
		if (!folder || !fs.existsSync(folder)) {
			return [];
		}

		const dirName = path.basename(folder);
		const files = await fs.promises.readdir(folder);
		const tabs: SketchTab[] = [];

		const mainInoName = `${dirName}.ino`;

		// 1. Main .ino first
		if (files.includes(mainInoName)) {
			const fullPath = path.join(folder, mainInoName);
			const content = await fs.promises.readFile(fullPath, 'utf8');
			tabs.push({
				name: mainInoName,
				uri: vscode.Uri.file(fullPath),
				content,
				isMainIno: true
			});
		}

		// 2. Other .ino files alphabetically
		const otherInos = files
			.filter(f => f.endsWith('.ino') && f !== mainInoName)
			.sort((a, b) => a.localeCompare(b));

		for (const f of otherInos) {
			const fullPath = path.join(folder, f);
			const content = await fs.promises.readFile(fullPath, 'utf8');
			tabs.push({
				name: f,
				uri: vscode.Uri.file(fullPath),
				content,
				isMainIno: false
			});
		}

		// 3. .h and .cpp files
		const sourceFiles = files
			.filter(f => (f.endsWith('.h') || f.endsWith('.hpp') || f.endsWith('.cpp') || f.endsWith('.c')) && !f.endsWith('.ino'))
			.sort((a, b) => a.localeCompare(b));

		for (const f of sourceFiles) {
			const fullPath = path.join(folder, f);
			const content = await fs.promises.readFile(fullPath, 'utf8');
			tabs.push({
				name: f,
				uri: vscode.Uri.file(fullPath),
				content,
				isMainIno: false
			});
		}

		return tabs;
	}

	public async getCombinedSketchCode(): Promise<string> {
		const tabs = await this.getSketchTabs();
		if (tabs.length === 0) {
			const activeEditor = vscode.window.activeTextEditor;
			return activeEditor ? activeEditor.document.getText() : '';
		}

		return tabs.map(t => `// ===== File: ${t.name} =====\n${t.content}`).join('\n\n');
	}

	public analyzeSketch(code: string, architecture: string = 'avr'): SketchAnalysisIssue[] {
		const issues: SketchAnalysisIssue[] = [];
		const lines = code.split(/\r?\n/);

		// 1. Check for blocking delay() calls
		const delayRegex = /\bdelay\s*\(\s*([0-9]+)\s*\)/g;
		lines.forEach((line, index) => {
			let match;
			while ((match = delayRegex.exec(line)) !== null) {
				const ms = parseInt(match[1], 10);
				if (ms >= 100) {
					issues.push({
						type: 'blocking_delay',
						severity: 'warning',
						line: index + 1,
						message: `Blocking delay(${ms}ms) pauses microcontroller execution, preventing responsive inputs and background tasks.`,
						recommendation: 'Replace with non-blocking timing using millis() and a state variable or timer interval.'
					});
				}
			}
		});

		// 2. Check for missing F() macro in Serial.print on AVR
		if (architecture === 'avr') {
			const serialPrintStringRegex = /Serial\s*\.\s*print(?:ln)?\s*\(\s*"([^"]{8,})"\s*\)/g;
			lines.forEach((line, index) => {
				let match;
				while ((match = serialPrintStringRegex.exec(line)) !== null) {
					issues.push({
						type: 'missing_f_macro',
						severity: 'info',
						line: index + 1,
						message: `String literal "${match[1]}" consumes precious SRAM (AVR only has 2KB total).`,
						recommendation: `Wrap the string with the F() macro: Serial.print(F("${match[1]}")) to store it in Flash ROM.`
					});
				}
			});
		}

		// 3. Check for dynamic String class usage in loop
		const hasStringClass = /\bString\s+[a-zA-Z0-9_]+\s*=/g.test(code);
		const inLoop = code.includes('void loop()');
		if (hasStringClass && inLoop && architecture === 'avr') {
			issues.push({
				type: 'string_heap_risk',
				severity: 'warning',
				message: 'Frequent use of Arduino String objects causes heap fragmentation on microcontrollers with small SRAM.',
				recommendation: 'Use standard C-style fixed char arrays (char buf[32]) and snprintf() instead of dynamic String objects.'
			});
		}

		// 4. Check for attachInterrupt and missing volatile
		const attachIntRegex = /attachInterrupt\s*\(\s*[^,]+,\s*([a-zA-Z0-9_]+)/;
		const intMatch = code.match(attachIntRegex);
		if (intMatch) {
			const isrName = intMatch[1];
			// Check if any variable modified in ISR is declared without volatile
			const isrFuncRegex = new RegExp(`void\\s+${isrName}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\}`, 'm');
			const isrFuncMatch = code.match(isrFuncRegex);
			if (isrFuncMatch) {
				const isrBody = isrFuncMatch[1];
				const modifiedVars = isrBody.match(/([a-zA-Z0-9_]+)\s*(\+\+|--|\+=|-=|=)/g);
				if (modifiedVars) {
					issues.push({
						type: 'missing_volatile_isr',
						severity: 'warning',
						message: `Interrupt Service Routine '${isrName}' modifies variables. Ensure any variable shared with the main loop is declared 'volatile'.`,
						recommendation: 'Example: volatile int counter = 0; This prevents the compiler from caching the variable in a CPU register.'
					});
				}
			}
		}

		return issues;
	}

	/**
	 * Find the target document URI for a given filename or path.
	 */
	public async resolveSketchFileUri(filename: string): Promise<vscode.Uri | undefined> {
		const cleanName = path.basename(filename.trim());

		// 1. Check open documents
		for (const doc of vscode.workspace.textDocuments) {
			if (path.basename(doc.uri.fsPath) === cleanName) {
				return doc.uri;
			}
		}

		// 2. Check active sketch tabs
		const tabs = await this.getSketchTabs();
		const tab = tabs.find(t => t.name === cleanName || t.name.toLowerCase() === cleanName.toLowerCase());
		if (tab) {
			return tab.uri;
		}

		// 3. Check active sketch folder
		const folder = this.getActiveSketchFolder();
		if (folder) {
			const candidate = path.join(folder, cleanName);
			if (fs.existsSync(candidate)) {
				return vscode.Uri.file(candidate);
			}
		}

		// 4. If absolute path provided and exists
		if (path.isAbsolute(filename) && fs.existsSync(filename)) {
			return vscode.Uri.file(filename);
		}

		// 5. Fallback to active editor if filename looks like main sketch or unspecified
		const active = vscode.window.activeTextEditor;
		if (active && (cleanName === 'main' || cleanName === 'sketch' || cleanName.endsWith('.ino'))) {
			return active.document.uri;
		}

		// 6. Fallback to main .ino tab
		const mainTab = tabs.find(t => t.isMainIno);
		if (mainTab) {
			return mainTab.uri;
		}

		return undefined;
	}

	public async applyFileEdit(filename: string, newContent: string): Promise<FileEditResult> {
		try {
			const targetUri = await this.resolveSketchFileUri(filename);
			if (!targetUri) {
				return {
					success: false,
					originalContent: '',
					filename,
					error: `Could not find sketch file '${filename}' to apply edit.`
				};
			}

			const doc = await vscode.workspace.openTextDocument(targetUri);
			const originalContent = doc.getText();

			// Store in edit history for undo / revert
			const uriKey = targetUri.toString();
			const history = this._editHistory.get(uriKey) || [];
			history.push(originalContent);
			this._editHistory.set(uriKey, history);

			// Perform replacement edit
			const lastLine = doc.lineCount > 0 ? doc.lineCount - 1 : 0;
			const lastChar = doc.lineCount > 0 ? doc.lineAt(lastLine).text.length : 0;
			const fullRange = new vscode.Range(0, 0, lastLine, lastChar);

			const edit = new vscode.WorkspaceEdit();
			edit.replace(targetUri, fullRange, newContent);
			const applied = await vscode.workspace.applyEdit(edit);

			if (applied) {
				await doc.save();
				// Show document in editor without stealing keyboard focus from chat
				try {
					await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
				} catch {}

				return {
					success: true,
					originalContent,
					filename: path.basename(targetUri.fsPath),
					uri: targetUri
				};
			} else {
				return {
					success: false,
					originalContent,
					filename: path.basename(targetUri.fsPath),
					uri: targetUri,
					error: `Failed to apply workspace edit to ${targetUri.fsPath}`
				};
			}
		} catch (error: any) {
			return {
				success: false,
				originalContent: '',
				filename,
				error: error?.message || String(error)
			};
		}
	}

	public async revertFileEdit(filename: string, previousContent?: string): Promise<boolean> {
		try {
			const targetUri = await this.resolveSketchFileUri(filename);
			if (!targetUri) return false;

			let contentToRestore = previousContent;
			if (contentToRestore === undefined) {
				const uriKey = targetUri.toString();
				const history = this._editHistory.get(uriKey);
				if (history && history.length > 0) {
					contentToRestore = history.pop();
				}
			}

			if (contentToRestore === undefined) {
				return false;
			}

			const doc = await vscode.workspace.openTextDocument(targetUri);
			const lastLine = doc.lineCount > 0 ? doc.lineCount - 1 : 0;
			const lastChar = doc.lineCount > 0 ? doc.lineAt(lastLine).text.length : 0;
			const fullRange = new vscode.Range(0, 0, lastLine, lastChar);

			const edit = new vscode.WorkspaceEdit();
			edit.replace(targetUri, fullRange, contentToRestore);
			const applied = await vscode.workspace.applyEdit(edit);
			if (applied) {
				await doc.save();
				try {
					await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
				} catch {}
				return true;
			}
			return false;
		} catch (error) {
			console.error(`[SketchService] Failed to revert edit for ${filename}:`, error);
			return false;
		}
	}
}
