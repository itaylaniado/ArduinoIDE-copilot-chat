/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { SerialTelemetryService } from '../services/serialTelemetryService';

describe('SerialTelemetryService', () => {
	it('should decode ESP32 Guru Meditation Error and extract backtrace addresses', () => {
		const service = new SerialTelemetryService();
		const panicSnippet = `
Guru Meditation Error: Core 1 panic'ed (LoadProhibited). Exception was unhandled.
Core 1 register dump:
PC      : 0x400d1234  PS      : 0x00060030  A0      : 0x800d5678  A1      : 0x3ffb0000
Backtrace:0x400d1234:0x3ffb0000 0x400d5678:0x3ffb0020 0x40082345:0x3ffb0040
`;
		const result = service.decodeBacktrace(panicSnippet);
		expect(result.isCrash).toBe(true);
		expect(result.crashType).toBe('LoadProhibited');
		expect(result.core).toBe(1);
		expect(result.explanation).toContain('NULL pointer dereference');
		expect(result.addresses.length).toBe(3);
		expect(result.addresses[0]).toBe('0x400d1234');
	});

	it('should detect ARM Cortex HardFault', () => {
		const service = new SerialTelemetryService();
		const faultSnippet = `[PANIC] HardFault occurred at PC: 0x08001234`;
		const result = service.decodeBacktrace(faultSnippet);
		expect(result.isCrash).toBe(true);
		expect(result.crashType).toBe('ARM Cortex HardFault');
	});

	it('should detect baud rate mismatch when serial stream contains unreadable garbage', () => {
		const service = new SerialTelemetryService();
		const gibberish = `\uFFFD\uFFFD\uFFFD\x00\x02\x03\uFFFD\uFFFD\uFFFD\uFFFD\x04\x05\uFFFD\uFFFD\uFFFD\uFFFD`;
		const sketch = `void setup() { Serial.begin(115200); }`;

		const check = service.checkBaudRate(gibberish, sketch);
		expect(check.hasMismatch).toBe(true);
		expect(check.detectedInSketch).toBe(115200);
		expect(check.suggestedBaud).toBe(115200);
	});
});
