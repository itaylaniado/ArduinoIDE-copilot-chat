/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createServiceIdentifier } from '../../../util/common/services';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ISketchService } from './sketchService';

export interface AgentSkill {
	id: string;
	name: string;
	description: string;
	instructions: string;
	isBuiltIn: boolean;
	enabled: boolean;
	sourcePath?: string;
}

export interface ISkillsService {
	readonly _serviceBrand: undefined;
	getSkills(): Promise<AgentSkill[]>;
	getSkill(id: string): Promise<AgentSkill | undefined>;
	toggleSkill(id: string, enabled: boolean): Promise<boolean>;
	createSkillTemplate(name: string, description: string, folder?: string): Promise<{ success: boolean; filePath?: string; error?: string }>;
	buildSkillsPrompt(): Promise<string>;
	refreshSkills(): Promise<void>;
}

export const ISkillsService = createServiceIdentifier<ISkillsService>('ISkillsService');

export const BUILTIN_SKILLS: AgentSkill[] = [
	{
		id: 'pinout-hardware-advisor',
		name: 'Pinout & Hardware Safety Advisor',
		description: 'Hardware constraints, 3.3V vs 5V logic safety, PWM/ADC pins, pull-ups, and GPIO current limits.',
		instructions: `#### Hardware & Electrical Safety Guidelines:
- **Operating Voltage & Logic Levels**: Always verify the microcontroller operating voltage (e.g. 5V for ATmega328P AVR vs 3.3V for ESP32/RP2040/SAMD). Explicitly warn when interfacing 5V sensors or modules to 3.3V GPIOs, and recommend bidirectional logic level converters or resistive voltage dividers.
- **GPIO Current Limits**: Standard GPIO pins safely source/sink 10-20mA (AVR max ~40mA; ESP32/RP2040 max ~12mA). Never drive high-current loads (motors, solenoids, power relays, high-power LEDs) directly from GPIO pins; advise using MOSFETs, transistors, or relay drivers with flyback diodes.
- **Dedicated Bus Pins**: Ensure correct wiring for I2C (SDA/SCL require pull-up resistors, usually 4.7kΩ), SPI (MOSI, MISO, SCK, CS), and hardware UART (TX/RX lines crossed to peripheral RX/TX).
- **ADC & Analog Inputs**: Confirm analog input voltage does not exceed reference voltage (AREF/VCC). Warn if high-impedance analog sources need decoupling capacitors.`,
		isBuiltIn: true,
		enabled: true
	},
	{
		id: 'library-dependency-helper',
		name: 'Library & Dependency Helper',
		description: 'Vetted Arduino library recommendations, proper #include syntaxes, and architecture compatibility.',
		instructions: `#### Arduino Library & Architecture Guidelines:
- **Canonical Libraries**: Prefer official and well-tested community libraries (e.g., Adafruit Sensor/GFX, ArduinoJson, FastLED, Wire, SPI, Servo, U8g2).
- **Architecture Compatibility**: Account for architecture differences between AVR, ARM Cortex-M (SAMD, RP2040, Renesas Uno R4), and Xtensa (ESP32/ESP8266). Avoid architecture-specific headers like \`<avr/io.h>\` or \`<avr/pgmspace.h>\` when writing portable cross-platform code.
- **Header Structure**: Include standard Arduino headers with proper guards, instantiate global drivers cleanly, and explain any library installation needed via the Arduino IDE Library Manager.`,
		isBuiltIn: true,
		enabled: true
	},
	{
		id: 'nonblocking-timing-expert',
		name: 'Non-Blocking Timing & State Machines',
		description: 'Eliminating delay(), implementing millis() state machines, software timers, and button debouncing.',
		instructions: `#### Non-Blocking Timing & Responsive Design:
- **Avoid delay()**: Never use blocking \`delay()\` in the main \`loop()\`, as it freezes sensor polling, serial communication, and user inputs.
- **millis() Scheduling**: Use \`unsigned long previousMillis\` timestamp tracking with delta comparison:
  \`if (currentMillis - previousMillis >= INTERVAL_MS) { previousMillis = currentMillis; ... }\` to avoid rollover bugs.
- **Finite State Machines**: Structure multi-phase tasks (e.g. heating, waiting, sensing, alerting) as state machines using \`enum State\` and \`switch (currentState)\`.
- **Button Debouncing**: Implement software debouncing for physical tactile switches using timestamp deltas or edge-detection rather than delay pauses.`,
		isBuiltIn: true,
		enabled: true
	},
	{
		id: 'serial-telemetry-plotter',
		name: 'Serial Telemetry & Plotter Formatter',
		description: 'Formatting serial output for the Arduino IDE Serial Plotter, baud rates, and structured telemetry.',
		instructions: `#### Serial Telemetry & Visualization:
- **Arduino IDE Serial Plotter**: Format multi-variable real-time data using tab-delimited label-value pairs:
  \`Serial.print(F("Temp:")); Serial.print(temp); Serial.print(F("\\tHum:")); Serial.println(hum);\`
- **Baud Rates**: Standardize on high, stable baud rates (e.g., 115200 baud) for telemetry to minimize CPU time spent in UART buffers.
- **String Memory Optimization**: Always wrap literal strings printed to Serial with the \`F()\` macro on AVR boards: \`Serial.println(F("Ready"));\` to conserve SRAM.`,
		isBuiltIn: true,
		enabled: true
	},
	{
		id: 'low-power-embedded',
		name: 'Low-Power & Battery IoT Expert',
		description: 'Sleep modes, watchdog timer wakeups, power-down configurations, and energy harvesting.',
		instructions: `#### Embedded Low-Power Optimization:
- **Sleep Modes**: Use deep sleep modes for battery-operated nodes (e.g. \`esp_deep_sleep_start()\` for ESP32 or \`LowPower.powerDown()\` for AVR).
- **Wake-up Triggers**: Configure external pin interrupts (e.g., push buttons, PIR sensors) or RTC timer alarms to wake the microcontroller from sleep.
- **Peripheral Power Management**: Turn off internal peripherals (ADC, SPI, brown-out detectors) and disable onboard LEDs when going to sleep to minimize quiescent current draw to microamps.`,
		isBuiltIn: true,
		enabled: true
	}
];

export class SkillsService extends Disposable implements ISkillsService {
	declare _serviceBrand: undefined;

	private _skills: AgentSkill[] = [];
	private _initialized = false;

	constructor(
		@ISketchService private readonly sketchService?: ISketchService
	) {
		super();
	}

	public async getSkills(): Promise<AgentSkill[]> {
		if (!this._initialized) {
			await this.refreshSkills();
		}
		return [...this._skills];
	}

	public async getSkill(id: string): Promise<AgentSkill | undefined> {
		const skills = await this.getSkills();
		return skills.find(s => s.id.toLowerCase() === id.toLowerCase());
	}

	public async toggleSkill(id: string, enabled: boolean): Promise<boolean> {
		const skills = await this.getSkills();
		const target = skills.find(s => s.id.toLowerCase() === id.toLowerCase());
		if (!target) {
			return false;
		}

		target.enabled = enabled;
		await this.persistDisabledState();
		return true;
	}

	/**
	 * Build aggregated instructions for all active/enabled skills to inject into the Copilot prompt.
	 */
	public async buildSkillsPrompt(): Promise<string> {
		const skills = await this.getSkills();
		const activeSkills = skills.filter(s => s.enabled);

		if (activeSkills.length === 0) {
			return '';
		}

		let prompt = `### Active Domain Skills & Hardware Rules:\n` +
			`Apply the following specialized embedded skills to your reasoning and code generation:\n\n`;

		for (const skill of activeSkills) {
			prompt += `#### Skill: ${skill.name}\n${skill.instructions.trim()}\n\n`;
		}

		return prompt;
	}

	/**
	 * Refresh and reload both built-in skills and user-defined skills from disk.
	 */
	public async refreshSkills(): Promise<void> {
		const disabledIds = this.loadDisabledSkillIds();

		// 1. Initialize Built-in Skills
		const list: AgentSkill[] = BUILTIN_SKILLS.map(s => ({
			...s,
			enabled: !disabledIds.has(s.id)
		}));

		// 2. Discover User-defined Skills
		const userSkills = await this.discoverUserSkills();
		for (const u of userSkills) {
			u.enabled = !disabledIds.has(u.id);
			list.push(u);
		}

		this._skills = list;
		this._initialized = true;
	}

	/**
	 * Create a scaffolded user skill markdown file in the active sketch's .skills/ directory.
	 */
	public async createSkillTemplate(
		name: string,
		description: string,
		targetDir?: string
	): Promise<{ success: boolean; filePath?: string; error?: string }> {
		try {
			let dir = targetDir;
			if (!dir && this.sketchService) {
				const sketchFolder = this.sketchService.getActiveSketchFolder();
				if (sketchFolder) {
					dir = path.join(sketchFolder, '.skills');
				}
			}

			if (!dir) {
				dir = path.join(os.homedir(), '.arduinoIDE', 'skills');
			}

			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}

			const fileSlug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'custom-skill';
			const filePath = path.join(dir, `${fileSlug}.md`);

			const template = `---
name: ${name}
description: ${description}
---

# ${name} Instructions

### Overview
${description}

### Guidelines for Arduino Copilot
- Detail any specific sensor calibrations, wiring rules, or board guidelines here.
- Example: "Always use hardware timer 1 for stepper pulses."
`;

			fs.writeFileSync(filePath, template, 'utf8');
			await this.refreshSkills();

			return { success: true, filePath };
		} catch (err: any) {
			return { success: false, error: err.message || String(err) };
		}
	}

	/**
	 * Discover user-defined markdown skills from:
	 * 1. Active sketch `.skills/` folder
	 * 2. User home `~/.arduinoIDE/skills/`
	 * 3. Custom path from `arduino.copilot.customSkillsPath`
	 */
	private async discoverUserSkills(): Promise<AgentSkill[]> {
		const searchDirs: string[] = [];

		// 1. Sketch folder .skills
		if (this.sketchService) {
			const sketchFolder = this.sketchService.getActiveSketchFolder();
			if (sketchFolder) {
				searchDirs.push(path.join(sketchFolder, '.skills'));
			}
		}

		// 2. Global ~/.arduinoIDE/skills
		searchDirs.push(path.join(os.homedir(), '.arduinoIDE', 'skills'));

		// 3. User configured path
		try {
			const config = vscode.workspace.getConfiguration('arduino.copilot');
			const customPath = config.get<string>('customSkillsPath');
			if (customPath && customPath.trim().length > 0) {
				searchDirs.push(customPath.trim());
			}
		} catch {}

		const userSkills: AgentSkill[] = [];
		const seenIds = new Set<string>();

		for (const dir of searchDirs) {
			if (!fs.existsSync(dir)) continue;

			try {
				const entries = fs.readdirSync(dir, { withFileTypes: true });
				for (const entry of entries) {
					let fullPath = '';
					if (entry.isFile() && entry.name.endsWith('.md')) {
						fullPath = path.join(dir, entry.name);
					} else if (entry.isDirectory()) {
						const skillMd = path.join(dir, entry.name, 'SKILL.md');
						if (fs.existsSync(skillMd)) {
							fullPath = skillMd;
						}
					}

					if (fullPath) {
						const parsed = this.parseSkillMarkdownFile(fullPath);
						if (parsed && !seenIds.has(parsed.id)) {
							seenIds.add(parsed.id);
							userSkills.push(parsed);
						}
					}
				}
			} catch (err) {
				console.warn(`[SkillsService] Error reading skills from ${dir}:`, err);
			}
		}

		return userSkills;
	}

	/**
	 * Parse YAML frontmatter and markdown body from a skill file.
	 */
	public parseSkillMarkdownFile(filePath: string): AgentSkill | undefined {
		try {
			const content = fs.readFileSync(filePath, 'utf8');
			const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);

			const fileBase = path.basename(filePath, '.md');
			let name = fileBase;
			let description = 'User-defined skill';
			let instructions = content;

			if (match) {
				const frontmatter = match[1];
				instructions = match[2].trim();

				const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
				if (nameMatch) {
					name = nameMatch[1].trim().replace(/^["']|["']$/g, '');
				}

				const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
				if (descMatch) {
					description = descMatch[1].trim().replace(/^["']|["']$/g, '');
				}
			}

			const id = 'user-' + name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');

			return {
				id,
				name,
				description,
				instructions,
				isBuiltIn: false,
				enabled: true,
				sourcePath: filePath
			};
		} catch (err) {
			console.warn(`[SkillsService] Failed to parse skill file ${filePath}:`, err);
			return undefined;
		}
	}

	private loadDisabledSkillIds(): Set<string> {
		try {
			const config = vscode.workspace.getConfiguration('arduino.copilot');
			const list = config.get<string[]>('disabledSkills');
			if (Array.isArray(list)) {
				return new Set(list);
			}
		} catch {}
		return new Set<string>();
	}

	private async persistDisabledState(): Promise<void> {
		try {
			const disabled = this._skills.filter(s => !s.enabled).map(s => s.id);
			const config = vscode.workspace.getConfiguration('arduino.copilot');
			await config.update('disabledSkills', disabled, vscode.ConfigurationTarget.Global);
		} catch {}
	}
}
