import type { FastifyReply } from "fastify";
import Stripe from "stripe";

function serializeStripeError(error: unknown, fallbackMessage: string) {
	if (!(error instanceof Stripe.errors.StripeError)) {
		return null;
	}

	switch (error.rawType) {
		case "card_error":
		case "invalid_request_error":
			return {
				statusCode: error.statusCode ?? 400,
				message: error.message || fallbackMessage,
			};
		case "rate_limit_error":
			return {
				statusCode: 503,
				message: fallbackMessage,
			};
		case "api_error":
		case "authentication_error":
		case "idempotency_error":
		case "invalid_grant":
		case "temporary_session_expired":
			return {
				statusCode: 502,
				message: fallbackMessage,
			};
	}

	switch (error.type) {
		case "StripePermissionError":
		case "StripeConnectionError":
		case "StripeSignatureVerificationError":
			return {
				statusCode: 502,
				message: fallbackMessage,
			};
		default:
			return {
				statusCode: error.statusCode ?? 502,
				message: error.message || fallbackMessage,
			};
	}
}

export function replyFromStripeError(
	reply: FastifyReply,
	error: unknown,
	fallbackMessage: string,
) {
	const serialized = serializeStripeError(error, fallbackMessage);
	if (!serialized) {
		return false;
	}

	reply.code(serialized.statusCode).send({ message: serialized.message });
	return true;
}
