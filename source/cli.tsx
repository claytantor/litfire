#!/usr/bin/env node
import {render} from 'ink';
import meow from 'meow';
import {App} from './app.js';
import {resolveStartup} from './vault/projects.js';

const cli = meow(
	`
	Usage
	  $ litfire [vault]

	  litfire <path>   open that vault
	  litfire .        open the current directory
	  litfire          reopen the last vault you worked in

	Options
	  --no-watch   Do not reload when the vault changes on disk

	Examples
	  $ litfire
	  $ litfire .
	  $ litfire ~/novels/dungeon-crawler
`,
	{
		importMeta: import.meta,
		flags: {
			watch: {type: 'boolean', default: true},
		},
	},
);

const startup = await resolveStartup(cli.input[0], process.cwd());
const version = cli.pkg.version ?? '0.0.0';

const {waitUntilExit} = render(
	<App root={startup.root} startup={startup} version={version} watch={cli.flags.watch} />,
	{
		// Tall output goes to the pager, so the dynamic region stays short and
		// incremental rendering keeps the composer off the redraw path.
		incrementalRendering: true,
		maxFps: 60,
	},
);

await waitUntilExit();
