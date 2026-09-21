/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { describe, it } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { SkillsService, BUILTIN_SKILLS } from '../services/skillsService.ts';
import { CopilotApiService, FALLBACK_COPILOT_MODELS } from '../services/copilotApiService.ts';

describe('Skills Service & Model Discovery Verification', () => {
	it('Loads all 5 built-in embedded development skills', async () => {
		const service = new SkillsService();
		const skills = await service.getSkills();

		assert.ok(skills.length >= 5);
		const pinoutSkill = skills.find(s => s.id === 'pinout-hardware-advisor');
		assert.ok(pinoutSkill);
		assert.strictEqual(pinoutSkill.isBuiltIn, true);
		assert.strictEqual(pinoutSkill.enabled, true);
		assert.match(pinoutSkill.instructions, /Logic Levels/);

		const timingSkill = skills.find(s => s.id === 'nonblocking-timing-expert');
		assert.ok(timingSkill);
		assert.match(timingSkill.instructions, /millis\(\)/);

		const librarySkill = skills.find(s => s.id === 'library-dependency-helper');
		assert.ok(librarySkill);

		const serialSkill = skills.find(s => s.id === 'serial-telemetry-plotter');
		assert.ok(serialSkill);
		assert.match(serialSkill.instructions, /Serial Plotter/);

		const lowPowerSkill = skills.find(s => s.id === 'low-power-embedded');
		assert.ok(lowPowerSkill);
		assert.match(lowPowerSkill.instructions, /Sleep Modes/);
	});

	it('Toggles skill enabled state and reflects in buildSkillsPrompt', async () => {
		const service = new SkillsService();
		await service.refreshSkills();

		let prompt = await service.buildSkillsPrompt();
		assert.match(prompt, /Pinout & Hardware Safety Advisor/);

		// Disable pinout skill
		const toggled = await service.toggleSkill('pinout-hardware-advisor', false);
		assert.strictEqual(toggled, true);

		const updatedSkill = await service.getSkill('pinout-hardware-advisor');
		assert.strictEqual(updatedSkill?.enabled, false);

		prompt = await service.buildSkillsPrompt();
		assert.doesNotMatch(prompt, /Pinout & Hardware Safety Advisor/);

		// Re-enable
		await service.toggleSkill('pinout-hardware-advisor', true);
		prompt = await service.buildSkillsPrompt();
		assert.match(prompt, /Pinout & Hardware Safety Advisor/);
	});

	it('Parses user markdown skill with YAML frontmatter correctly', () => {
		const service = new SkillsService();
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
		const sampleFile = path.join(tmpDir, 'stepper-helper.md');

		const mdContent = `---
name: Stepper Motor Calibration
description: Specialized rules for microstepping and acceleration curves
---

# Instructions
Always set enable pin LOW before pulse train...
`;
		fs.writeFileSync(sampleFile, mdContent, 'utf8');

		const parsed = service.parseSkillMarkdownFile(sampleFile);
		assert.ok(parsed);
		assert.strictEqual(parsed.name, 'Stepper Motor Calibration');
		assert.strictEqual(parsed.description, 'Specialized rules for microstepping and acceleration curves');
		assert.match(parsed.instructions, /Always set enable pin LOW/);
		assert.strictEqual(parsed.isBuiltIn, false);
		assert.strictEqual(parsed.enabled, true);

		// Clean up
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('Scaffolds and creates a user skill template file', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-scaffold-'));
		const mockSketchService = {
			getActiveSketchFolder: () => tmpDir,
			getSketchTabs: async () => []
		} as any;

		const service = new SkillsService(mockSketchService);
		const result = await service.createSkillTemplate(
			'CAN Bus Protocol',
			'CAN bus message identifiers and transceiver baud rates',
			path.join(tmpDir, '.skills')
		);

		assert.strictEqual(result.success, true);
		assert.ok(result.filePath);
		assert.strictEqual(fs.existsSync(result.filePath), true);

		const content = fs.readFileSync(result.filePath, 'utf8');
		assert.match(content, /CAN Bus Protocol/);
		assert.match(content, /CAN bus message identifiers/);

		// Clean up
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('Validates Copilot model fallbacks and endpoint resolution', () => {
		assert.ok(FALLBACK_COPILOT_MODELS.length >= 4);
		assert.ok(FALLBACK_COPILOT_MODELS.some(m => m.id === 'gpt-4o'));
		assert.ok(FALLBACK_COPILOT_MODELS.some(m => m.id === 'claude-3.5-sonnet'));
		assert.ok(FALLBACK_COPILOT_MODELS.some(m => m.id === 'o1-mini'));

		const apiService = new CopilotApiService();
		const defaultUrl = apiService.getApiBaseUrl();
		assert.strictEqual(defaultUrl, 'https://api.individual.githubcopilot.com');

		const businessUrl = apiService.getApiBaseUrl('https://api.business.githubcopilot.com/');
		assert.strictEqual(businessUrl, 'https://api.business.githubcopilot.com');
	});
});
