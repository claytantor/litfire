/**
 * Every color and glyph the UI uses. Keeping them here means a restyle is one
 * file, and it keeps `chalk` out of component logic.
 */
export const theme = {
	color: {
		brand: '#ff6b35',
		user: '#7aa2f7',
		assistant: '#9ece6a',
		system: '#bb9af7',
		muted: '#565f89',
		error: '#f7768e',
		border: '#3b4261',
	},
	symbol: {
		user: '›',
		assistant: '⏺',
		system: '◆',
		error: '✖',
	},
} as const;

export const roleColor = {
	user: theme.color.user,
	assistant: theme.color.assistant,
	system: theme.color.system,
} as const;

export const roleSymbol = {
	user: theme.symbol.user,
	assistant: theme.symbol.assistant,
	system: theme.symbol.system,
} as const;
