import type {
	DeprovisionResult,
	ParsedWebhookEvent,
	ProviderAdapter,
	ProvisionResult,
	Resource,
} from "./provider-adapter.js";

export class MockAdapter implements ProviderAdapter {
	readonly providerName = "mock";
	private _shouldFailProvision = false;
	private _mockProviderRef = "mock_ref_123";

	setShouldFailProvision(v: boolean) {
		this._shouldFailProvision = v;
	}

	setMockProviderRef(ref: string) {
		this._mockProviderRef = ref;
	}

	async provision(
		_agentId: string,
		_config: Record<string, unknown>,
	): Promise<ProvisionResult> {
		if (this._shouldFailProvision) throw new Error("Mock provision failure");
		await Promise.resolve();
		return { providerRef: this._mockProviderRef };
	}

	async deprovision(_resource: Resource): Promise<DeprovisionResult> {
		await Promise.resolve();
		return {};
	}

	async performAction(
		_resource: Resource,
		_action: string,
		_payload: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		await Promise.resolve();
		return {};
	}

	async verifyWebhook(
		_rawBody: Buffer,
		_headers: Record<string, string>,
	): Promise<boolean> {
		await Promise.resolve();
		return true;
	}

	async parseWebhook(
		_rawBody: Buffer,
		_headers: Record<string, string>,
	): Promise<ParsedWebhookEvent[]> {
		await Promise.resolve();
		return [];
	}
}
