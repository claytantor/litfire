import {z} from 'zod';

export const roleSchema = z.enum(['user', 'assistant', 'system']);
export type Role = z.infer<typeof roleSchema>;

export const messageSchema = z.object({
	id: z.string(),
	role: roleSchema,
	content: z.string(),
	at: z.number().int(),
});

export type Message = z.infer<typeof messageSchema>;

/**
 * What the UI is doing right now. The composer, status bar, and key handling
 * all branch on this, so it lives in one place rather than as scattered
 * booleans that can contradict each other.
 */
export type ChatStatus = 'idle' | 'streaming' | 'error';

let counter = 0;

export function createMessage(role: Role, content: string, at: number): Message {
	counter += 1;
	return {id: `${at.toString(36)}-${counter}`, role, content, at};
}
