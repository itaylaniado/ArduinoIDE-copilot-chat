/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { IBoardContextService } from '../services/boardContextService';

export interface CircuitParams {
	componentName: string;
	fqbn?: string;
}

export interface CircuitOutput {
	component: string;
	wiringTable: Array<{ componentPin: string; targetPin: string; description: string }>;
	mermaidDiagram: string;
	asciiDiagram: string;
	safetyNotes: string[];
}

export class ArduinoCircuitDiagramTool {
	public static readonly toolName = 'arduino_circuit_diagram';
	public static readonly description = 'Generate breadboard wiring tables, ASCII schematics, and Mermaid wiring diagrams for connecting sensors and actuators to Arduino.';

	constructor(private readonly boardContextService: IBoardContextService) {}

	public async execute(params: CircuitParams): Promise<CircuitOutput> {
		const board = params.fqbn
			? (this.boardContextService.getProfile(params.fqbn) || this.boardContextService.getActiveBoard())
			: this.boardContextService.getActiveBoard();

		const comp = params.componentName.toLowerCase();
		const wiringTable: CircuitOutput['wiringTable'] = [];
		const safetyNotes: string[] = [];
		let mermaidDiagram = '';
		let asciiDiagram = '';

		if (comp.includes('dht') || comp.includes('temp')) {
			wiringTable.push(
				{ componentPin: 'Pin 1 (VCC)', targetPin: board.voltage === 3.3 ? '3.3V' : '5V', description: 'Power supply (3V-5V)' },
				{ componentPin: 'Pin 2 (DATA)', targetPin: 'Digital Pin 2', description: 'Signal with 10kΩ pull-up resistor to VCC' },
				{ componentPin: 'Pin 3 (NC)', targetPin: 'Not Connected', description: 'Leave disconnected' },
				{ componentPin: 'Pin 4 (GND)', targetPin: 'GND', description: 'Ground rail' }
			);

			safetyNotes.push('Include a 4.7kΩ - 10kΩ pull-up resistor between the DATA line and VCC.');

			mermaidDiagram = `graph LR
    Arduino["${board.name}"] ---|5V / 3.3V| DHT["DHT Sensor (VCC)"]
    Arduino ---|GND| DHT_GND["DHT (GND)"]
    Arduino ---|Pin 2| DHT_DATA["DHT (DATA)"]
    DHT_DATA -.->|10kΩ Pull-up| DHT`;

			asciiDiagram = `
   +------------------+             +-----------------+
   |                  | --- VCC --> | Pin 1: VCC      |
   | ${board.name.padEnd(16)} | --- GND --> | Pin 4: GND      |
   |                  |             |                 |
   |           Pin 2  | <== DATA => | Pin 2: DATA     |
   +------------------+             +-----------------+
                                      |   ^
                                   [ 10kΩ ] (Pull-up to VCC)
`;
		} else if (comp.includes('oled') || comp.includes('i2c') || comp.includes('ssd1306')) {
			wiringTable.push(
				{ componentPin: 'VCC', targetPin: '5V or 3.3V', description: 'Check if module has on-board regulator' },
				{ componentPin: 'GND', targetPin: 'GND', description: 'Common ground' },
				{ componentPin: 'SCL', targetPin: `SCL (Pin ${board.i2cPins.scl})`, description: 'I2C Clock Line' },
				{ componentPin: 'SDA', targetPin: `SDA (Pin ${board.i2cPins.sda})`, description: 'I2C Data Line' }
			);

			safetyNotes.push(`I2C pins on ${board.name} are SDA=${board.i2cPins.sda} and SCL=${board.i2cPins.scl}.`);
			safetyNotes.push('Standard I2C addresses for SSD1306 are 0x3C or 0x3D.');

			mermaidDiagram = `graph LR
    Arduino["${board.name}"] ---|VCC| OLED["OLED Display (VCC)"]
    Arduino ---|GND| OLED_GND["OLED (GND)"]
    Arduino ---|SDA (${board.i2cPins.sda})| OLED_SDA["OLED (SDA)"]
    Arduino ---|SCL (${board.i2cPins.scl})| OLED_SCL["OLED (SCL)"]`;

			asciiDiagram = `
   +------------------+             +-----------------+
   |                  | --- VCC --> | VCC             |
   | ${board.name.padEnd(16)} | --- GND --> | GND             |
   |                  |             |                 |
   |  SDA (Pin ${String(board.i2cPins.sda).padEnd(4)})| <=========> | SDA (I2C Data)  |
   |  SCL (Pin ${String(board.i2cPins.scl).padEnd(4)})| ----------> | SCL (I2C Clock) |
   +------------------+             +-----------------+
`;
		} else if (comp.includes('servo')) {
			wiringTable.push(
				{ componentPin: 'Red (Power)', targetPin: '5V (External Supply recommended)', description: 'Servos draw high peak current' },
				{ componentPin: 'Brown/Black (GND)', targetPin: 'GND (Common ground)', description: 'Connect external ground to Arduino GND' },
				{ componentPin: 'Orange/Yellow (Signal)', targetPin: 'Pin 9 (PWM)', description: 'Servo PWM control signal' }
			);

			safetyNotes.push('Do NOT power standard RC servos directly from the Arduino 5V pin under load; use an external 5V-6V power source with shared ground.');

			mermaidDiagram = `graph LR
    Arduino["${board.name}"] ---|Pin 9| ServoSig["Servo (Signal)"]
    Arduino ---|Common GND| ExtGND["GND Rail"]
    ExtPower["External 5V PSU"] ---|5V| ServoVCC["Servo (VCC)"]
    ExtPower ---|GND| ExtGND
    ExtGND ---|GND| ServoGND["Servo (GND)"]`;

			asciiDiagram = `
   +------------------+
   | ${board.name.padEnd(16)} | --- Pin 9 (PWM) ====> [ Orange: Servo Signal ]
   |                  |
   |              GND | ----+
   +------------------+     |
                            v
   +------------------+   [ Common GND Rail ] ===> [ Brown: Servo GND ]
   | External 5V PSU  |     ^
   |             5V+  | ----|----------------====> [ Red: Servo VCC ]
   |             GND  | ----+
   +------------------+
`;
		} else {
			// Generic wiring
			wiringTable.push(
				{ componentPin: 'VCC / Power', targetPin: `${board.voltage}V`, description: `Board logic voltage is ${board.voltage}V` },
				{ componentPin: 'GND', targetPin: 'GND', description: 'Ground' },
				{ componentPin: 'Signal', targetPin: 'Digital/Analog Pin', description: 'Connect to appropriate GPIO pin' }
			);

			mermaidDiagram = `graph LR
    Arduino["${board.name}"] ---|Power (${board.voltage}V)| Component["${params.componentName}"]
    Arduino ---|GND| CompGND["Ground"]
    Arduino ---|GPIO| CompSig["Signal"]`;

			asciiDiagram = `
   +------------------+             +-----------------+
   | ${board.name.padEnd(16)} | --- Power-> | VCC             |
   |                  | --- GND --> | GND             |
   |             GPIO | <=========> | Signal          |
   +------------------+             +-----------------+
`;
		}

		if (board.voltage === 3.3) {
			safetyNotes.push(`Warning: ${board.name} operates at 3.3V logic. Ensure ${params.componentName} inputs do not exceed 3.3V.`);
		}

		return {
			component: params.componentName,
			wiringTable,
			mermaidDiagram,
			asciiDiagram,
			safetyNotes
		};
	}
}
