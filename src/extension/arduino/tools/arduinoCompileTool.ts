/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { IArduinoCliService } from '../services/arduinoCliService';
import { IBoardContextService } from '../services/boardContextService';
import { ISketchService } from '../services/sketchService';

export interface ArduinoCompileParams {
	sketchPath?: string;
	fqbn?: string;
}

export interface ArduinoCompileOutput {
	success: boolean;
	summary: string;
	ramUsage?: string;
	flashUsage?: string;
	errors?: string[];
	rawOutput: string;
}

export class ArduinoCompileTool {
	public static readonly toolName = 'arduino_compile';
	public static readonly description = 'Compile and verify an Arduino sketch for the active or specified board (FQBN) using arduino-cli.';

	constructor(
		private readonly arduinoCliService: IArduinoCliService,
		private readonly boardContextService: IBoardContextService,
		private readonly sketchService: ISketchService
	) {}

	public async execute(params: ArduinoCompileParams): Promise<ArduinoCompileOutput> {
		const targetFqbn = params.fqbn || this.boardContextService.getActiveBoard().fqbn;
		const targetSketch = params.sketchPath || this.sketchService.getActiveSketchFolder();

		if (!targetSketch) {
			return {
				success: false,
				summary: 'No active Arduino sketch folder found to compile.',
				rawOutput: ''
			};
		}

		const result = await this.arduinoCliService.compile(targetSketch, targetFqbn);
		if (result.success) {
			let ramStr: string | undefined;
			let flashStr: string | undefined;

			if (result.builderResult) {
				const { usedRam, totalRam, usedFlash, totalFlash } = result.builderResult;
				if (usedRam !== undefined && totalRam !== undefined && totalRam > 0) {
					const pct = ((usedRam / totalRam) * 100).toFixed(1);
					ramStr = `${usedRam} bytes / ${totalRam} bytes (${pct}%)`;
				}
				if (usedFlash !== undefined && totalFlash !== undefined && totalFlash > 0) {
					const pct = ((usedFlash / totalFlash) * 100).toFixed(1);
					flashStr = `${usedFlash} bytes / ${totalFlash} bytes (${pct}%)`;
				}
			}

			const boardName = this.boardContextService.getActiveBoard().name;
			const summary = `Compilation SUCCESS for ${boardName} (${targetFqbn}).` +
				(flashStr ? ` Flash: ${flashStr}.` : '') +
				(ramStr ? ` RAM: ${ramStr}.` : '');

			return {
				success: true,
				summary,
				ramUsage: ramStr,
				flashUsage: flashStr,
				rawOutput: result.compilerOutput
			};
		} else {
			const errorLines = (result.errorOutput || '')
				.split(/\r?\n/)
				.filter(l => l.includes('error:') || l.includes('fatal error:'));

			return {
				success: false,
				summary: `Compilation FAILED for ${targetFqbn}. Found ${errorLines.length || 'compiler'} errors.`,
				errors: errorLines,
				rawOutput: result.errorOutput || result.compilerOutput
			};
		}
	}
}
