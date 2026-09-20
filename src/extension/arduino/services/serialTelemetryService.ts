/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

export interface BacktraceDecodeResult {
	isCrash: boolean;
	crashType?: string;
	core?: number;
	registers?: Record<string, string>;
	addresses: string[];
	explanation: string;
	recommendedFix: string;
}

export interface BaudRateCheckResult {
	hasMismatch: boolean;
	detectedInSketch?: number;
	suggestedBaud?: number;
	explanation?: string;
}

export interface ISerialTelemetryService {
	readonly _serviceBrand: undefined;
	decodeBacktrace(logSnippet: string): BacktraceDecodeResult;
	checkBaudRate(serialSnippet: string, sketchCode?: string): BaudRateCheckResult;
}

export const ISerialTelemetryService = createServiceIdentifier<ISerialTelemetryService>('ISerialTelemetryService');

export class SerialTelemetryService extends Disposable implements ISerialTelemetryService {
	declare _serviceBrand: undefined;

	constructor() {
		super();
	}

	public decodeBacktrace(logSnippet: string): BacktraceDecodeResult {
		// Detect ESP32 Guru Meditation Error
		const isEsp32Panic = logSnippet.includes('Guru Meditation Error') || logSnippet.includes('Backtrace:');
		const isArmHardFault = logSnippet.includes('HardFault') || logSnippet.includes('UsageFault') || logSnippet.includes('BusFault');

		if (isEsp32Panic) {
			const typeMatch = logSnippet.match(/Guru Meditation Error:\s*Core\s*([0-9]+)\s*panic'ed\s*\(([^)]+)\)/);
			const core = typeMatch ? parseInt(typeMatch[1], 10) : undefined;
			const crashType = typeMatch ? typeMatch[2] : 'Kernel Panic';

			// Extract backtrace addresses: Backtrace:0x40081234:0x3ffb0000 0x400d5678:0x3ffb0020
			const backtraceMatch = logSnippet.match(/Backtrace:\s*([0-9a-fA-Fx:\s]+)/);
			const addresses: string[] = [];
			if (backtraceMatch) {
				const raw = backtraceMatch[1].trim().split(/\s+/);
				for (const item of raw) {
					const parts = item.split(':');
					if (parts[0].startsWith('0x')) {
						addresses.push(parts[0]);
					}
				}
			}

			let explanation = `ESP32 crashed with a '${crashType}' error on CPU Core ${core ?? 0}. `;
			let fix = '';

			if (crashType.includes('LoadProhibited') || crashType.includes('StoreProhibited')) {
				explanation += 'This indicates a NULL pointer dereference or accessing an uninitialized pointer address.';
				fix = 'Check all pointer variables and arrays to ensure they are properly allocated and not NULL before dereferencing.';
			} else if (crashType.includes('IntegerDivideByZero')) {
				explanation += 'The microcontroller attempted to divide a number by zero.';
				fix = 'Add a check: if (denominator != 0) before performing any division or modulo operations.';
			} else if (crashType.includes('Unhandled debug exception') || crashType.includes('abort()')) {
				explanation += 'The firmware called abort() or encountered a failed assert() check.';
				fix = 'Check recent assertions, FreeRTOS task stack allocations, or WiFi/Bluetooth stack initialization.';
			} else if (crashType.includes('Interrupt wdt timeout')) {
				explanation += 'The Interrupt Watchdog Timer expired because a task or ISR blocked execution for too long without yielding.';
				fix = 'Ensure loops yield with delay() or vTaskDelay(1), and that Interrupt Service Routines (ISRs) are minimal.';
			} else {
				explanation += 'Microcontroller halted to prevent corrupted memory execution.';
				fix = 'Review the call stack and inspect recent pointer operations or buffer bounds.';
			}

			return {
				isCrash: true,
				crashType,
				core,
				addresses,
				explanation,
				recommendedFix: fix
			};
		}

		if (isArmHardFault) {
			return {
				isCrash: true,
				crashType: 'ARM Cortex HardFault',
				addresses: [],
				explanation: 'ARM Cortex processor executed an illegal instruction, accessed invalid bus memory, or encountered stack overflow.',
				recommendedFix: 'Verify array boundaries, check stack size for RTOS tasks, and confirm peripheral clock registers are enabled before accessing them.'
			};
		}

		return {
			isCrash: false,
			addresses: [],
			explanation: 'No known microcontroller crash signature detected in the provided log snippet.',
			recommendedFix: 'Provide full serial log output including boot messages or stack traces if available.'
		};
	}

	public checkBaudRate(serialSnippet: string, sketchCode?: string): BaudRateCheckResult {
		// Detect Serial.begin(xxxx) in sketch
		let sketchBaud: number | undefined;
		if (sketchCode) {
			const baudMatch = sketchCode.match(/Serial\s*\.\s*begin\s*\(\s*([0-9]+)\s*\)/);
			if (baudMatch) {
				sketchBaud = parseInt(baudMatch[1], 10);
			}
		}

		// Detect unreadable framing noise / gibberish characters (replacement character, null bytes, non-ASCII garbage)
		const garbageCharsCount = (serialSnippet.match(/[\uFFFD\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\xFF]/g) || []).length;
		const isGibberish = serialSnippet.length > 10 && (garbageCharsCount / serialSnippet.length) > 0.25;

		if (isGibberish) {
			const suggested = sketchBaud || 115200;
			return {
				hasMismatch: true,
				detectedInSketch: sketchBaud,
				suggestedBaud: suggested,
				explanation: `The Serial Monitor output contains corrupted/garbled characters typical of a baud rate mismatch. ${sketchBaud ? `Your sketch specifies ${sketchBaud} baud.` : 'Standard Arduino baud rate is 115200 or 9600.'}`
			};
		}

		return {
			hasMismatch: false,
			detectedInSketch: sketchBaud
		};
	}
}
