/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { SketchService } from '../services/sketchService';

describe('SketchService', () => {
	it('should detect blocking delay() calls and advise non-blocking timing', () => {
		const service = new SketchService();
		const code = `
void loop() {
  digitalWrite(13, HIGH);
  delay(1000);
  digitalWrite(13, LOW);
  delay(500);
}
`;
		const issues = service.analyzeSketch(code, 'avr');
		const delays = issues.filter(i => i.type === 'blocking_delay');
		expect(delays.length).toBe(2);
		expect(delays[0].recommendation).toContain('millis()');
	});

	it('should recommend F() macro for long string literals in Serial.print on AVR', () => {
		const service = new SketchService();
		const code = `
void setup() {
  Serial.begin(9600);
  Serial.println("System initialization started successfully...");
}
`;
		const issues = service.analyzeSketch(code, 'avr');
		const fMacroIssues = issues.filter(i => i.type === 'missing_f_macro');
		expect(fMacroIssues.length).toBe(1);
		expect(fMacroIssues[0].recommendation).toContain('F("System initialization started successfully...")');
	});

	it('should detect missing volatile qualifier on variables modified in ISR', () => {
		const service = new SketchService();
		const code = `
int pulseCount = 0;

void onPulse() {
  pulseCount++;
}

void setup() {
  attachInterrupt(digitalPinToInterrupt(2), onPulse, RISING);
}
`;
		const issues = service.analyzeSketch(code, 'avr');
		const isrIssues = issues.filter(i => i.type === 'missing_volatile_isr');
		expect(isrIssues.length).toBe(1);
		expect(isrIssues[0].recommendation).toContain('volatile');
	});
});
