// ============================================================================
// Metrics tracking for Discord bot
// ============================================================================

export interface BotMetrics {
	messagesReceived: number;
	messagesResponded: number;
	reconnections: number;
	startTime: Date;
	queueDepths: Map<string, number>;
	tokenUsage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalCost: number;
	};
}

export class MetricsCollector {
	private metrics: BotMetrics = {
		messagesReceived: 0,
		messagesResponded: 0,
		reconnections: 0,
		startTime: new Date(),
		queueDepths: new Map(),
		tokenUsage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalCost: 0,
		},
	};

	incrementReceived(): void {
		this.metrics.messagesReceived++;
	}

	incrementResponded(): void {
		this.metrics.messagesResponded++;
	}

	incrementReconnections(): void {
		this.metrics.reconnections++;
	}

	setQueueDepth(channelId: string, depth: number): void {
		this.metrics.queueDepths.set(channelId, depth);
	}

	addTokenUsage(usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: { total: number };
	}): void {
		this.metrics.tokenUsage.input += usage.input;
		this.metrics.tokenUsage.output += usage.output;
		this.metrics.tokenUsage.cacheRead += usage.cacheRead;
		this.metrics.tokenUsage.cacheWrite += usage.cacheWrite;
		this.metrics.tokenUsage.totalCost += usage.cost.total;
	}

	getMetrics(): Readonly<BotMetrics> {
		return this.metrics;
	}

	getUptimeSeconds(): number {
		return Math.floor((Date.now() - this.metrics.startTime.getTime()) / 1000);
	}

	formatStatus(sessionCount: number): string {
		const uptime = this.getUptimeSeconds();
		const hours = Math.floor(uptime / 3600);
		const minutes = Math.floor((uptime % 3600) / 60);
		const seconds = uptime % 60;
		const uptimeStr = `${hours}h ${minutes}m ${seconds}s`;

		const lines: string[] = [
			"**Bot Status**",
			`Uptime: ${uptimeStr}`,
			`Messages received: ${this.metrics.messagesReceived}`,
			`Messages responded: ${this.metrics.messagesResponded}`,
			`Reconnections: ${this.metrics.reconnections}`,
			`Active sessions: ${sessionCount}`,
		];

		if (this.metrics.queueDepths.size > 0) {
			const depths = Array.from(this.metrics.queueDepths.entries())
				.filter(([, d]) => d > 0)
				.map(([id, d]) => `  ${id}: ${d}`)
				.join("\n");
			if (depths) {
				lines.push(`Queue depths:\n${depths}`);
			}
		}

		return lines.join("\n");
	}

	formatCosts(): string {
		const u = this.metrics.tokenUsage;
		const lines: string[] = [
			"**Token Usage**",
			`Input: ${u.input.toLocaleString()} tokens`,
			`Output: ${u.output.toLocaleString()} tokens`,
		];

		if (u.cacheRead > 0 || u.cacheWrite > 0) {
			lines.push(`Cache read: ${u.cacheRead.toLocaleString()} tokens`);
			lines.push(`Cache write: ${u.cacheWrite.toLocaleString()} tokens`);
		}

		lines.push(`**Total cost: $${u.totalCost.toFixed(4)}**`);
		return lines.join("\n");
	}
}

export const globalMetrics = new MetricsCollector();
