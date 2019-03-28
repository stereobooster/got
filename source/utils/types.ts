import { GotError } from './../errors';
import { URL } from 'url';
import {IncomingMessage, Agent, request as httpRequest} from 'http';
import {RequestOptions, request as httpsRequest } from 'https';
import {Readable as ReadableStream} from 'stream';
import PCancelable from 'p-cancelable';
import {Hooks} from '../known-hook-events';
import {CookieJar} from 'tough-cookie';

type JSONValue = string | number | boolean | null | undefined | JSONObject | JSONArray;
interface JSONObject extends Record<string, JSONValue> {}
interface JSONArray extends Array<JSONValue> {}

export type Method = 'GET' | 'PUT' | 'HEAD' | 'DELETE' | 'OPTIONS' | 'TRACE' | 'get' | 'put' | 'head' | 'delete' | 'options' | 'trace' | 'POST' | 'post' | 'PATCH' | 'patch';
export type ErrorCode = 'ETIMEDOUT' | 'ECONNRESET' | 'EADDRINUSE' | 'ECONNREFUSED' | 'EPIPE' | 'ENOTFOUND' | 'ENETUNREACH' | 'EAI_AGAIN';
export type StatusCode = 408 | 413 | 429 | 500 | 502 | 503 | 504;

export type NextFunction = (error?: Error | string) => void;

export type IterateFunction = (options: Options) => void;

export interface Response extends IncomingMessage {
	body: string | Buffer;
	statusCode: number;
}

export type GotURL = string | URL | {protocol: string, port: number, agent: Agent }

export interface SearchParams {
	[key: string]: string | number | boolean | null;
}

export interface Timings {
	start: number;
	socket: number | null;
	lookup: number | null;
	connection: number | null;
	upload: number | null;
	response: number | null;
	request: number | null;
	end: number | null;
	error: number | null;
	phases: {
		wait: number | null;
		dns: number | null;
		tcp: number | null;
		request: number | null;
		firstByte: number | null;
		download: number | null;
		total: number | null;
	};
}

export interface Instance {
	methods?: Method[];
	options: Partial<Options>;
	handler: (options: Options, callback: NextFunction) => void;
}

export interface InterfaceWithDefaults extends Instance {
	defaults: {
		handler: (options: Options, callback: NextFunction | IterateFunction) => void;
		options: Options;
	};
}

export interface RetryOption {
	retries?: ((retry: number, error: GotError) => number) | number;
	methods?: Set<Method> | Array<Method>;
	statusCodes?: Set<StatusCode> | Array<StatusCode>;
	errorCodes?: Set<ErrorCode> | Array<ErrorCode>;
	maxRetryAfter?: number;
}

export interface MergedOptions extends Options {
	retry: RetryOption;
}

export interface DefaultOptions {
	options: Partial<Options>;
	mutableDefaults?: boolean;
	handler?: <T>(options: MergedOptions, next: (_: MergedOptions) => T) => T;
}

export type Request = typeof httpRequest | typeof httpsRequest;

export interface Options extends RequestOptions {
	host?: string;
	body?: string | Buffer | ReadableStream; // | form-data
	hostname?: string;
	path?: string;
	socketPath?: string;
	protocol?: string;
	href?: string;
	hooks?: Partial<Hooks>;
	decompress?: boolean;
	encoding?: BufferEncoding | null;
	method?: Method;
	retry?: RetryOption | number;
	throwHttpErrors?: boolean;
	cookieJar?: CookieJar;
	followRedirect?: boolean;
	form?: URLSearchParams | string | { [key: string]: string | string[] | undefined; } | Iterable<[string, string]> | [string, string][];
	json?: JSONValue;
	useElectronNet?: boolean;
	responseType?: string;
	gotTimeout?: Timings;
	resolveBodyOnly?: boolean;
	baseUrl?: string | URL;
	request?: Request;
	cache?: Map<string, unknown>;
	dnsCache?: Map<string, unknown>;
	stream?: unknown;
	lookup?: unknown;
	mutableDefaults?: boolean;
	searchParams?: URLSearchParams | SearchParams;
	query?: URLSearchParams | SearchParams;
	url?: GotURL;
}

export interface CancelableRequest<T extends IncomingMessage> extends PCancelable<T> {
	on(name: string, listener: () => void): CancelableRequest<T>;
	json(): CancelableRequest<T>;
	buffer(): CancelableRequest<T>;
	text(): CancelableRequest<T>;
}
