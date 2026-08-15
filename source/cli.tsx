#!/usr/bin/env node
import {render} from 'ink';
import meow from 'meow';
import {App} from './app.js';
import {createEchoEngine} from './engine/echo.js';

const cli = meow(
	`
	Usage
	  $ litfire

	Options
	  --delay <ms>   Simulated inter-token delay for the echo engine (default 45)

	Examples
	  $ litfire
	  $ litfire --delay 10
`,
	{
		importMeta: import.meta,
		flags: {
			delay: {
				type: 'number',
				default: 45,
			},
		},
	},
);

const engine = createEchoEngine(cli.flags.delay);

const version = cli.pkg.version ?? '0.0.0';

const {waitUntilExit} = render(<App engine={engine} version={version} />, {
	// A streaming transcript repaints constantly; incremental rendering rewrites
	// only the lines that changed, which is what keeps the composer from
	// flickering on every token.
	incrementalRendering: true,
	maxFps: 60,
});

await waitUntilExit();
