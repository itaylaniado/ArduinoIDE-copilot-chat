/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { ISerialTelemetryService, BacktraceDecodeResult, BaudRateCheckResult } from '../services/serialTelemetryService';
import { ISketchService } from '../services/sketchService';

export interface CrashDecodeParams {
	serialSnippet: string;
}

export interface CrashDecodeOutput {
	crashAnalysis: BacktraceDecodeResult;
	baudRateCheck: BaudRateCheckResult;
	summary: string;
}

export class ArduinoCrashDecodeTool {
	public static readonly toolName = 'arduino_crash_decoder';
	public static readonly description = 'Analyze Serial Monitor logs, stack backtraces (ESP32 Guru Meditation Error, ARM HardFault), and baud rate mismatches.';

	constructor(
		private readonly serialTelemetryService: ISerialTelemetryService,
		private readonly sketchService: ISketchService
	) {}

	public async execute(params: CrashDecodeParams): Promise<CrashDecodeOutput> {
		const sketchCode = await this.sketchService.getCombinedSketchCode();
		const crashAnalysis = this.serialTelemetryService.decodeBacktrace(params.serialSnippet);
		const baudRateCheck = this.serialTelemetryService.checkBaudRate(params.serialSnippet, sketchCode);

		let summary = '';
		if (crashAnalysis.isCrash) {
			summary += `🚨 **${crashAnalysis.crashType}** Detected!\n\n` +
				`• **Root Cause**: ${crashAnalysis.explanation}\n` +
				`• **Recommended Solution**: ${crashAnalysis.recommendedFix}\n`;
			if (crashAnalysis.addresses.length > 0) {
				summary += `• **Stack Addresses**: ${crashAnalysis.addresses.join(', ')}\n`;
			}
		}

		if (baudRateCheck.hasMismatch) {
			summary += `\n⚠️ **Baud Rate Mismatch Detected**:\n` +
				`${baudRateCheck.explanation}\n` +
				`Try setting your Serial Monitor baud rate to **${baudRateCheck.suggestedBaud}**.\n`;
		}

		if (!crashAnalysis.isCrash && !baudRateCheck.hasMismatch) {
			summary = 'No hardware crash signatures or baud rate framing errors detected in this serial log.';
		}

		return {
			crashAnalysis,
			baudRateCheck,
			summary
		};
	}
}
