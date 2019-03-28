import { Timings, Request } from './utils/types';
import {CookieJar} from 'tough-cookie';
import urlLib, {URL, URLSearchParams} from 'url'; // TODO: Use the `URL` global when targeting Node.js 10
import util from 'util';
import EventEmitter from 'events';
import {Transform as TransformStream} from 'stream';
import http from 'http';
import https from 'https';
// @ts-ignore
import CacheableRequest from 'cacheable-request';
import toReadableStream from 'to-readable-stream';
import is from '@sindresorhus/is';
// @ts-ignore
import timer from '@szmarczak/http-timer';
import timedOut, {TimeoutError as TimedOutTimeoutError} from './utils/timed-out';
import getBodySize from './utils/get-body-size';
import isFormData from './utils/is-form-data';
import getResponse from './get-response';
import {uploadProgress} from './progress';
import { CacheError, UnsupportedProtocolError, MaxRedirectsError, RequestError, TimeoutError, GotError, HTTPError } from './errors';
import urlToOptions from './utils/url-to-options';

import {Options} from './utils/types';

const getMethodRedirectCodes = new Set([300, 301, 302, 303, 304, 305, 307, 308]);
const allMethodRedirectCodes = new Set([300, 303, 307, 308]);

const withoutBody = new Set(['GET', 'HEAD']);

interface SpecialEventEmitter extends EventEmitter {
	retry: (error: HTTPError) => void | boolean;
	abort: () => void;
}

export default (options: Options, input?: TransformStream) => {
	const emitter = new EventEmitter();
	const redirects: string[] = [];
	let currentRequest: Options["request"];
	let requestUrl: string;
	let redirectString: string;
	let uploadBodySize: number | undefined;
	let retryCount = 0;
	let shouldAbort = false;

	const setCookie = options.cookieJar ? util.promisify(options.cookieJar.setCookie.bind(options.cookieJar)) : null;
	const getCookieString = options.cookieJar ? util.promisify<string, CookieJar.GetCookiesOptions>(options.cookieJar.getCookieString.bind(options.cookieJar)) : null;
	const agents = is.object(options.agent) ? options.agent : null;

	const emitError = async (error: GotError) => {
		if (!options.hooks || !options.hooks.beforeError) return;
		try {
			for (const hook of options.hooks.beforeError) {
				// eslint-disable-next-line no-await-in-loop
				error = await hook(error);
			}

			emitter.emit('error', error);
		} catch (error2) {
			emitter.emit('error', error2);
		}
	};

	const get = async (options: Options) => {
		const currentUrl = redirectString || requestUrl;

		if (options.protocol !== 'http:' && options.protocol !== 'https:') {
			throw new UnsupportedProtocolError(options);
		}

		decodeURI(currentUrl);

		let fn;
		if (is.function_(options.request)) {
			fn = {request: options.request};
		} else {
			fn = options.protocol === 'https:' ? https : http;
		}

		if (agents) {
			const protocolName = options.protocol === 'https:' ? 'https' : 'http';
			options.agent = agents[protocolName] || options.agent;
		}

		/* istanbul ignore next: electron.net is broken */
		if (options.useElectronNet && (process.versions as any).electron) {
			// @ts-ignore
			const r = ({x: require})['yx'.slice(1)]; // Trick webpack
			const electron = r('electron');
			fn = electron.net || electron.remote.net;
		}

		if (options.cookieJar && getCookieString) {
			const cookieString = await getCookieString(currentUrl, {});

			if (is.nonEmptyString(cookieString) && options.headers) {
				options.headers.cookie = cookieString;
			}
		}

		let timings: Timings;
		const handleResponse = async response => {
			try {
				/* istanbul ignore next: fixes https://github.com/electron/electron/blob/cbb460d47628a7a146adf4419ed48550a98b2923/lib/browser/api/net.js#L59-L65 */
				if (options.useElectronNet) {
					response = new Proxy(response, {
						get: (target, name) => {
							if (name === 'trailers' || name === 'rawTrailers') {
								return [];
							}

							const value = target[name];
							return is.function_(value) ? value.bind(target) : value;
						}
					});
				}

				const {statusCode} = response;
				response.url = currentUrl;
				response.requestUrl = requestUrl;
				response.retryCount = retryCount;
				response.timings = timings;
				response.redirectUrls = redirects;
				response.request = {
					gotOptions: options
				};

				const rawCookies = response.headers['set-cookie'];
				if (options.cookieJar && rawCookies && setCookie) {
					await Promise.all(rawCookies.map((rawCookie: string) => setCookie(rawCookie, response.url)));
				}

				if (options.followRedirect && 'location' in response.headers) {
					if (allMethodRedirectCodes.has(statusCode) || (getMethodRedirectCodes.has(statusCode) && (options.method === 'GET' || options.method === 'HEAD'))) {
						response.resume(); // We're being redirected, we don't care about the response.

						if (statusCode === 303) {
							// Server responded with "see other", indicating that the resource exists at another location,
							// and the client should request it from that location via GET or HEAD.
							options.method = 'GET';
						}

						if (redirects.length >= 10) {
							throw new MaxRedirectsError(statusCode, redirects, options);
						}

						// Handles invalid URLs. See https://github.com/sindresorhus/got/issues/604
						const redirectBuffer = Buffer.from(response.headers.location, 'binary').toString();
						const redirectURL = new URL(redirectBuffer, currentUrl);
						redirectString = redirectURL.toString();

						redirects.push(redirectString);

						const redirectOptions = {
							...options,
							port: undefined,
							...urlToOptions(redirectURL)
						};

						if (options.hooks && options.hooks.beforeRedirect) {
							for (const hook of options.hooks.beforeRedirect) {
								// eslint-disable-next-line no-await-in-loop
								await hook(redirectOptions);
							}
						}

						emitter.emit('redirect', response, redirectOptions);

						await get(redirectOptions);
						return;
					}
				}

				getResponse(response, options, emitter);
			} catch (error) {
				emitError(error);
			}
		};

		const handleRequest = (request: Request) => {
			if (shouldAbort) {
				request.abort();
				return;
			}

			currentRequest = request;

			request.on('error', (error: GotError) => {
				if (request.aborted || error.message === 'socket hang up') {
					return;
				}

				if (error instanceof TimedOutTimeoutError) {
					error = new TimeoutError(error, timings, options);
				} else {
					error = new RequestError(error, options);
				}

				if ((emitter as SpecialEventEmitter).retry && (emitter as SpecialEventEmitter).retry(error) === false) {
					emitError(error);
				}
			});

			timings = timer(request);

			uploadProgress(request, emitter, uploadBodySize);

			if (options.gotTimeout) {
				timedOut(request, options.gotTimeout, options);
			}

			emitter.emit('request', request);

			const uploadComplete = () => {
				request.emit('upload-complete');
			};

			try {
				if (is.nodeStream(options.body)) {
					options.body.once('end', uploadComplete);
					options.body.pipe(request);
					options.body = undefined;
				} else if (options.body) {
					request.end(options.body, uploadComplete);
				} else if (input && (options.method === 'POST' || options.method === 'PUT' || options.method === 'PATCH')) {
					input.once('end', uploadComplete);
					input.pipe(request);
				} else {
					request.end(uploadComplete);
				}
			} catch (error) {
				emitError(new RequestError(error, options));
			}
		};

		if (options.cache) {
			const cacheableRequest = new CacheableRequest(fn.request, options.cache);
			const cacheRequest = cacheableRequest(options, handleResponse);

			cacheRequest.once('error', (error: GotError) => {
				if (error instanceof CacheableRequest.RequestError) {
					emitError(new RequestError(error, options));
				} else {
					emitError(new CacheError(error, options));
				}
			});

			cacheRequest.once('request', handleRequest);
		} else {
			// Catches errors thrown by calling fn.request(...)
			try {
				handleRequest(fn.request(options, handleResponse));
			} catch (error) {
				emitError(new RequestError(error, options));
			}
		}
	};

	(emitter as SpecialEventEmitter).retry = (error: HTTPError) => {
		let backoff;

		if (is.object(options.retry) && is.boundFunction(options.retry.retries)) {
			try {
				backoff = options.retry.retries(++retryCount, error);
			} catch (error2) {
				emitError(error2);
				return;
			}
		}

		if (backoff) {
			const retry = async (options: Options) => {
				if (options.hooks && options.hooks.beforeRetry) {
					try {
						for (const hook of options.hooks.beforeRetry) {
							// eslint-disable-next-line no-await-in-loop
							await hook(options, error, retryCount);
						}

						await get(options);
					} catch (error) {
						emitError(error);
					}
				}
			};

			setTimeout(retry, backoff, {...options, forceRefresh: true});
			return true;
		}

		return false;
	};

	(emitter as SpecialEventEmitter).abort = () => {
		if (currentRequest) {
			currentRequest.abort();
		} else {
			shouldAbort = true;
		}
	};

	setImmediate(async () => {
		try {
			if (options.hooks && options.hooks.beforeRequest) {
				for (const hook of options.hooks.beforeRequest) {
					// eslint-disable-next-line no-await-in-loop
					await hook(options);
				}
			}

			if (!options.headers) {
				throw new TypeError('The `headers` option is required');
			}

			// Serialize body
			const {body, headers} = options;
			const isForm = !is.nullOrUndefined(options.form);
			const isJSON = !is.nullOrUndefined(options.json);
			const isBody = !is.nullOrUndefined(body);
			if ((isBody || isForm || isJSON) && options.method && withoutBody.has(options.method)) {
				throw new TypeError(`The \`${options.method}\` method cannot be used with a body`);
			}

			if (isBody) {
				if (isForm || isJSON) {
					throw new TypeError('The `body` option cannot be used with the `json` option or `form` option');
				}

				if (is.object(body) && isFormData(body)) {
					// Special case for https://github.com/form-data/form-data
					headers['content-type'] = headers['content-type'] || `multipart/form-data; boundary=${body.getBoundary()}`;
				} else if (!is.nodeStream(body) && !is.string(body) && !is.buffer(body)) {
					throw new TypeError('The `body` option must be a stream.Readable, string, Buffer, Object or Array');
				}
			} else if (isForm) {
				if (!is.object(options.form)) {
					throw new TypeError('The `form` option must be an Object');
				}

				headers['content-type'] = headers['content-type'] || 'application/x-www-form-urlencoded';
				options.body = (new URLSearchParams(options.form)).toString();
			} else if (isJSON) {

				headers['content-type'] = headers['content-type'] || 'application/json';
				options.body = JSON.stringify(options.json);
			}

			// Convert buffer to stream to receive upload progress events (#322)
			if (is.buffer(body)) {
				options.body = toReadableStream(body);
				uploadBodySize = body.length;
			} else {
				uploadBodySize = await getBodySize(options);
			}

			if (is.undefined(headers['content-length']) && is.undefined(headers['transfer-encoding'])) {
				if (!is.undefined(uploadBodySize) && (uploadBodySize > 0 || options.method === 'PUT')) {
					headers['content-length'] = uploadBodySize;
				}
			}

			if (!options.stream && options.responseType === 'json' && is.undefined(headers.accept)) {
				options.headers.accept = 'application/json';
			}

			requestUrl = options.href || (new URL(options.path, urlLib.format(options))).toString();

			await get(options);
		} catch (error) {
			emitError(error);
		}
	});

	return emitter as SpecialEventEmitter;
};
