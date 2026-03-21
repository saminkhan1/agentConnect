export function readStringArray(value: unknown) {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

export function normalizeStringArray(value: unknown) {
	return readStringArray(value);
}

export function normalizeSortedStringArray(value: unknown) {
	return [...readStringArray(value)].sort((left, right) =>
		left.localeCompare(right),
	);
}

export function normalizeOptionalString(value: unknown) {
	return typeof value === "string" ? value : "";
}

export function normalizeNullableString(value: unknown) {
	return typeof value === "string" ? value : null;
}

export function normalizeNullableNumber(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeUnknownRecord(value: unknown) {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function normalizeEmailAddress(value: unknown) {
	if (typeof value !== "string") {
		return null;
	}

	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return null;
	}

	const match = trimmed.match(/<([^<>]+)>/);
	return (match?.[1] ?? trimmed).trim();
}

export function normalizeEmailAddressArray(value: unknown) {
	return (Array.isArray(value) ? value : []).flatMap((entry) => {
		const normalized = normalizeEmailAddress(entry);
		return normalized ? [normalized] : [];
	});
}
