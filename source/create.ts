import { InterfaceWithDefaults } from './../dist/source/utils/types.d';
import { IncomingMessage } from 'http';
import { MergedOptions, Options, GotURL, DefaultOptions, CancelableRequest } from './utils/types';
import * as errors from './errors';
import asStream from './as-stream';
import asPromise from './as-promise';
import {normalizeArguments, preNormalizeArguments} from './normalize-arguments';
import merge, {mergeOptions, mergeInstances} from './merge';
import deepFreeze from './utils/deep-freeze';
import { Duplex } from 'stream';

const getPromiseOrStream = (options: MergedOptions) => options.stream ? asStream(options) : asPromise(options);

type LowerCaseMethods = 'get' | 'post' | 'put' | 'patch' | 'head' | 'delete';

const aliases: Array<LowerCaseMethods> = [
	'get',
	'post',
	'put',
	'patch',
	'head',
	'delete'
];

type GotFunction = (url: GotURL, options?: Options) => Duplex | CancelableRequest<IncomingMessage>;
export interface Got extends GotFunction {
	'get': GotFunction;
	'post': GotFunction;
	'put': GotFunction;
	'patch': GotFunction;
	'head': GotFunction;
	'delete': GotFunction;
	stream: {
		'get': GotFunction;
		'post': GotFunction;
		'put': GotFunction;
		'patch': GotFunction;
		'head': GotFunction;
		'delete': GotFunction;
	}
}

const create = (defaults: DefaultOptions): Got => {
	defaults = merge({}, defaults);
	preNormalizeArguments(defaults.options);

	if (!defaults.handler) {
		// This can't be getPromiseOrStream, because when merging
		// the chain would stop at this point and no further handlers would be called.
		defaults.handler = <T>(options: MergedOptions, next: (_: MergedOptions) => T) => next(options);
	}

	function got(url: GotURL, options?: Options) {
		try {
			return defaults.handler!(normalizeArguments(url, options, defaults), getPromiseOrStream);
		} catch (error) {
			if (options && options.stream) {
				throw error;
			} else {
				return Promise.reject(error);
			}
		}
	};

	got.create = create;
	got.extend = (options: Options) => {
		let mutableDefaults;
		if (options && Reflect.has(options, 'mutableDefaults')) {
			mutableDefaults = options.mutableDefaults;
			delete options.mutableDefaults;
		} else {
			mutableDefaults = defaults.mutableDefaults;
		}

		return create({
			options: mergeOptions(defaults.options, options),
			handler: defaults.handler,
			mutableDefaults
		});
	};

	got.mergeInstances = (...args:InterfaceWithDefaults[]) => create(mergeInstances(args));

	got.stream = (url: GotURL, options?: Options) => got(url, {...options, stream: true});

	for (const method of aliases) {
		// @ts-ignore
		got[method] = (url: GotURL, options?: Options) => got(url, {...options, method});
		// @ts-ignore
		got.stream[method] = (url: GotURL, options?: Options) => got.stream(url, {...options, method});
	}

	Object.assign(got, {...errors, mergeOptions});
	Object.defineProperty(got, 'defaults', {
		value: defaults.mutableDefaults ? defaults : deepFreeze(defaults),
		writable: defaults.mutableDefaults,
		configurable: defaults.mutableDefaults,
		enumerable: true
	});

	return got as any;
};

export default create;
