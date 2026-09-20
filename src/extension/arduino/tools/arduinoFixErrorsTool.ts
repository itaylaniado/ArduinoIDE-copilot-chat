/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { IArduinoCliService } from '../services/arduinoCliService';
import { IBoardContextService } from '../services/boardContextService';
import { ISketchService } from '../services/sketchService';

export interface CompilerDiagnostic {
	file: string;
	line: number;
	column?: number;
	severity: 'error' | 'warning';
	message: string;
	isMissingLibrary?: boolean;
	suggestedLibrary?: string;
}

export interface FixErrorsOutput {
	hasErrors: boolean;
	diagnostics: CompilerDiagnostic[];
	analysis: string;
	suggestedActions: string[];
}

export class ArduinoFixErrorsTool {
	public static readonly toolName = 'arduino_fix_compile_errors';
	public static readonly description = 'Diagnose Arduino compilation errors, map preprocessed line numbers back to .ino sketch files, and provide solutions.';

	constructor(
		private readonly arduinoCliService: IArduinoCliService,
		private readonly boardContextService: IBoardContextService,
		private readonly sketchService: ISketchService
	) {}

	public async execute(params?: { errorLog?: string }): Promise<FixErrorsOutput> {
		let rawLog = params?.errorLog;

		if (!rawLog) {
			const folder = this.sketchService.getActiveSketchFolder();
			const board = this.boardContextService.getActiveBoard();
			if (!folder) {
				return {
					hasErrors: false,
					diagnostics: [],
					analysis: 'No active Arduino sketch folder found to diagnose.',
					suggestedActions: []
				};
			}

			const compResult = await this.arduinoCliService.compile(folder, board.fqbn);
			if (compResult.success) {
				return {
					hasErrors: false,
					diagnostics: [],
					analysis: 'Sketch compiles cleanly with zero errors.',
					suggestedActions: []
				};
			}
			rawLog = compResult.errorOutput || compResult.compilerOutput;
		}

		const diagnostics = this.parseCompilerOutput(rawLog);
		const suggestedActions: string[] = [];

		let analysis = `Detected ${diagnostics.length} compiler diagnostic(s):\n\n`;
		for (const diag of diagnostics) {
			analysis += `- **${diag.file}:${diag.line}**: ${diag.message}\n`;
			if (diag.isMissingLibrary && diag.suggestedLibrary) {
				suggestedActions.push(`Install library: '${diag.suggestedLibrary}' via Library Manager`);
			}
		}

		if (diagnostics.some(d => d.message.includes('was not declared in this scope'))) {
			suggestedActions.push('Check for typos in variable/function names or missing function prototypes before setup()');
		}
		if (diagnostics.some(d => d.message.includes('expected') && d.message.includes(';'))) {
			suggestedActions.push('Missing semicolon (;) on or immediately before the indicated line');
		}

		return {
			hasErrors: diagnostics.length > 0,
			diagnostics,
			analysis,
			suggestedActions
		};
	}

	private parseCompilerOutput(output: string): CompilerDiagnostic[] {
		const lines = output.split(/\r?\n/);
		const diagnostics: CompilerDiagnostic[] = [];

		// Matches formats like:
		// /path/to/sketch.ino:12:5: error: 'val' was not declared in this scope
		// /tmp/.../sketch.ino.cpp:24:10: fatal error: Adafruit_BME280.h: No such file or directory
		const diagRegex = /([^:\s]+):([0-9]+):(?:([0-9]+):)?\s*(error|fatal error|warning):\s*(.+)/;

		for (const line of lines) {
			const match = line.match(diagRegex);
			if (match) {
				const rawFile = match[1];
				const rawLine = parseInt(match[2], 10);
				const column = match[3] ? parseInt(match[3], 10) : undefined;
				const severity = match[4].includes('error') ? 'error' : 'warning';
				const message = match[5].trim();

				let isMissingLibrary = false;
				let suggestedLibrary: string | undefined;

				const libMatch = message.match(/(?:fatal error:\s*)?([^:]+\.h):\s*No such file or directory/i);
				if (libMatch) {
					isMissingLibrary = true;
					const header = libMatch[1];
					suggestedLibrary = header.replace(/\.h$/, '');
				}

				diagnostics.push({
					file: rawFile.split(/[/\\]/).pop() || rawFile,
					line: rawLine,
					column,
					severity,
					message,
					isMissingLibrary,
					suggestedLibrary
				});
			}
		}

		return diagnostics;
	}
}
