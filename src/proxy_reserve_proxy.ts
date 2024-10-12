#!/usr/bin/env node

// SPDX-License-Identifier: GPL-3.0-only

'use strict';

import * as http from 'http';
import type * as net from 'net';
import type * as stream from 'stream';
import * as https from 'https';
import * as assert from 'assert';
import * as process from 'process';

namespace utils_{

	// Assumes that req is not used by other http methods at the same time.
	function request_connect(req: http.ClientRequest): Promise<[http.IncomingMessage, net.Socket, Buffer]>{
		return new Promise<[http.IncomingMessage, net.Socket, Buffer]>((resolve, reject) => {
			req.once('connect', (res: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
				//let a: [http.IncomingMessage, net.Socket, Buffer] = ;
				resolve([res, socket, head]);
			});

			req.once('error', (err: Error) => {
				reject(err);
			});
		});
	}

//	function request_end(req: http.ClientRequest): Promise<void>{
//		return new Promise<void>((resolve) => {
//			req.end(() => {
//				resolve();
//			});
//		});
//	}

	// Assumes that req is not used by other http methods at the same time.
	function request_response(req: http.ClientRequest): Promise<http.IncomingMessage>{
		return new Promise<http.IncomingMessage>((resolve, reject) => {
			req.once('response', (res: http.IncomingMessage) => {
				resolve(res);
			});

			req.once('error', (err: Error) => {
				reject(err);
			});
		});
	};

	function array_shift<T>(arr: T[]): T{
		// LUL wat. https://github.com/whatwg/console/issues/77
		assert.ok(arr.length > 0);
		return arr.shift() as T;
	}

	function reject_end_or_error(ending: true | Error, reject: (reason?: any) => void){
		if(ending instanceof Error){
			reject(ending);
			return ;
		}
		reject();
		return ;
	}

	type read_chunk_type = any;
	type write_chunk_type = any;

	export class readable_data{
		private m_stream: stream.Readable;
		private m_pending_data: read_chunk_type[];
		private m_pending_continuations: [(value: read_chunk_type | PromiseLike<any>) => void, (reason?: any) => void][];
		private m_ending: true | Error | undefined;

		public constructor(stream: stream.Readable){
			this.m_stream = stream;
			this.m_pending_data = [];
			this.m_pending_continuations = [];
			//this.m_ended = stream.readableAborted || stream.readableEnded;
			// If m_stream is aborted with neither `end` nor `error`, we assume
			// this object be destroyed with pending_continuation hang up as
			// well.
			if(this.m_stream.errored !== null){
				this.m_ending = this.m_stream.errored;
			}
			else if(this.m_stream.readableEnded){
				this.m_ending = true;
			}
			else{
				this.m_ending = undefined;
			}

			this.m_stream.once('end', () => {
				if(this.m_ending instanceof Error){
					// TODO: what to do?
					return ;
				}

				this.finish_ending(true); // Will catch an error of `undefined`.
			});

			this.m_stream.on('data', (chunk: any) => {
				assert.ok(this.m_ending === undefined);

				if(this.m_pending_continuations.length === 0){
					//assert.ok(this.m_pending_data.length >= 0);
					this.m_pending_data.push(chunk);
					return ;
				}

				assert.ok(this.m_pending_continuations.length > 0);
				let [first_resolve, ] = array_shift(this.m_pending_continuations);
				first_resolve(chunk);
				return ;
			});

			this.m_stream.once('error', (err: Error) => {
				if(this.m_ending === true){
					// TODO: what to do?
					return ;
				}

				this.finish_ending(err);
			});
		}

		private finish_ending(this: readable_data, ending: true | Error){
			this.m_ending = ending;
			assert.ok((this.m_pending_data.length === 0) || (this.m_pending_continuations.length === 0));
			for(let [, current_reject] of this.m_pending_continuations){
				reject_end_or_error(this.m_ending, current_reject);
			}
			this.m_pending_continuations = [];
		}

//		private async *foo(): AsyncGenerator<any, void, void>{
//			yield 3;
//			return ;
//		}

		public read(this: readable_data): Promise<read_chunk_type>{
			return new Promise<read_chunk_type>((resolve, reject) => {
				if(this.m_pending_data.length > 0){
					assert.ok(this.m_pending_continuations.length === 0);
					let first_chunk = array_shift(this.m_pending_data);
					resolve(first_chunk);
					return ;
				}

				assert.ok(this.m_pending_data.length === 0);
				//assert.ok(this.m_pending_continuations.length >= 0);
				if(this.m_ending != undefined){
					assert.ok(this.m_pending_continuations.length === 0);
					reject_end_or_error(this.m_ending, reject);
					return ;
				}
				assert.ok(this.m_ending === undefined);
				this.m_pending_continuations.push([resolve, reject]);
				return ;
			});
		}
	}; // class readable_data

	export async function *readable_contents(reader: readable_data): AsyncGenerator<read_chunk_type, void, void>{
		while(true){
			try{
				let value = await reader.read();
				yield value;
			}
			catch(err: unknown){
				if(err === undefined){
					break;
				}
				else if(err instanceof Error){
					throw err;
				}
				throw err;
			}
		}
		return ;
	}

	interface writeable_write_args{
		chunk: write_chunk_type,
		encoding?: BufferEncoding | undefined
	}; // interface writeable_write_args

	export class writeable_writer{
		private m_stream: stream.Writable;
		private m_pending_continuations: [(value: void | PromiseLike<void>) => void, (reason: any) => void][];
		// TODO: handle `encoding` parameter of `write`
		private m_pending_actions: [writeable_write_args, (value: void | PromiseLike<void>) => void, (reason: any) => void][];

		public constructor(stream: stream.Writable){
			this.m_stream = stream;
			this.m_pending_continuations = [];
			this.m_pending_actions = [];
			// We're unable to detect if m_stream is finished or not here. So
			// we cannot handle 'finish' event and we have to assume the user
			// not to call `Writeable.end` before

			this.m_stream.on('drain', () => {
				for(let [resolve, ] of this.m_pending_continuations){
					resolve();
				}
				this.m_pending_continuations = [];
				for(let [write_args, resolve, reject] of this.m_pending_actions){
					this.do_one_write(write_args, resolve, reject);
				}
				this.m_pending_actions = [];
			});

			this.m_stream.once('error', (err: Error) => {
				for(let [, reject] of this.m_pending_continuations){
					reject(err);
				}
				this.m_pending_continuations = [];
				for(let [, , reject] of this.m_pending_actions){
					reject(err);
				}
				this.m_pending_actions = [];

				// We do not add flags indicating if m_stream is already errored
				// or not. It's user's responsibility of ensuring not to write
				// again after m_stream is errored.
				// TODO: at least make `write` throw if m_stream is already
				// errored.
			});
		}

		private do_one_write(
			this: writeable_writer,
			write_args: writeable_write_args,
			resolve: (value: void | PromiseLike<void>) => void,
			reject: (reason: any) => void
		): void{
			assert.ok((this.m_pending_continuations.length > 0) === this.m_stream.writableNeedDrain);
			const write_ret = (() => {
				let encoding = write_args.encoding;
				if(encoding === undefined){
					return this.m_stream.write(write_args.chunk, () => {
						resolve();
					});
				}
				return this.m_stream.write(write_args.chunk, encoding, () => {
					resolve();
				});
			})();
			if(write_ret){
				return ;
			}
			this.m_pending_continuations.push([resolve, reject]);
			return ;
		}

		// TODO: add constness
		private write_impl(this: writeable_writer, write_args: writeable_write_args): Promise<void>{
			return new Promise<void>((resolve, reject) => {
				if((this.m_pending_continuations.length > 0) && !this.m_stream.writableNeedDrain){
					// We consider in this case the `drain` event is already
					// emitted yet the corresponding callback is not called yet.
					// Push this call into `m_pending_actions` and wait for
					// the callback of `drain` being called.
					this.m_pending_actions.push([write_args, resolve, reject]);
					return ;
				}
				this.do_one_write(write_args, resolve, reject);
				return ;
			});
		}

		public write(this: writeable_writer, chunk: write_chunk_type): Promise<void>;
		public write(this: writeable_writer, chunk: write_chunk_type, encoding: BufferEncoding): Promise<void>;
		public write(this: writeable_writer, chunk: write_chunk_type, encoding?: BufferEncoding): Promise<void>{
			const write_args = ((): writeable_write_args => {
				if(encoding === undefined){
					return {
						chunk: chunk
					};
				};
				return {
					chunk: chunk,
					encoding: encoding
				};
			})();
			return this.write_impl(write_args);
		}
	}; // class writeable_writer

	export interface https_proxy_request_options{
		// `auth` affects headers. Either we directly copy headers from client
		// to headers to upstream server, or we extract needed `auth` values
		// from client headers and set this `auth` property.
		auth?: string | undefined,
		body?: AsyncGenerator<read_chunk_type, void, void>,
		headers?: http.OutgoingHttpHeaders | undefined,
		host: string,
		method: string,
		path: string,
		proxy_host: string,
		proxy_port: number,
		port?: number | undefined
	}; // interface https_proxy_request_options

	interface http_status{
		code: number,
		message?: string | undefined
	}; // interface http_status

	export async function https_proxy_read(options: Readonly<https_proxy_request_options>){
		const options_port = options.port ?? 443;

		const conn_opt: http.RequestOptions = {
			host: options.proxy_host,
			port: options.proxy_port,
			method: 'CONNECT',
			path: options.host + ':' + String(options_port)
		};
		let conn_req = http.request(conn_opt);
		conn_req.end();
		let [, socket, ] = await request_connect(conn_req);

		const actual_agent = new https.Agent({
			socket: socket
		});
		const actual_opt = ((): https.RequestOptions => {
			let ret: https.RequestOptions = {
				host: options.host,
				port: options_port,
				method: options.method,
				path: options.path,
				agent: actual_agent
			};
			if(options.auth !== undefined){
				ret.auth = options.auth;
			}
			return ret;
		})();
		let actual_req = https.request(actual_opt);
//		const client_header = actual_req.getHeaders();
//		console.log('client_header: %s', client_header);
//		for(const key in client_header){
//			console.log('client_header key: %s , value %s', key, client_header[key]);
//		}
		if(options.headers !== undefined){
			for(const [name, value] of Object.entries(options.headers)){
				if(value !== undefined){
					actual_req.setHeader(name, value);
				}
			}
		}
		if(options.body !== undefined){
			let body_reader = options.body;
			let body_writer = new writeable_writer(actual_req);
			// TODO: add constness following the constness of writeable_writer
			for await(let data of body_reader){
				// May throw
				await body_writer.write(data);
			}
		}
		actual_req.end();

		let actual_res = await request_response(actual_req);
		const status = ((): http_status => {
			let ret: http_status = {
				// TODO: console.warn
				code: actual_res.statusCode ?? 200
			};
			const message = actual_res.statusMessage;
			if(message !== undefined){
				ret.message = message
			}
			return ret;
		})();
		const server_header = actual_res.headers;

		let res_reader = new readable_data(actual_res);
		// TODO: add constness
		return {
			server_status: status,
			server_header: server_header,
			// https://stackoverflow.com/questions/27661306/can-i-use-es6s-arrow-function-syntax-with-generators-arrow-notation
			server_body: readable_contents(res_reader)
		};
	}

} // namespace utils_

//async function foo(): Promise<void>{
//	const {server_status, server_header, server_body} = await utils_.https_proxy_read({
////		host: 'www.google.com',
//		host: 'arch.asus-linux.org',
//		port: 443,
//		method: 'GET',
//		//path: '/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png',
//		path: '/',
//		proxy_host: '127.0.0.1',
//		proxy_port: 1081
//	});
//	console.log('server_status: %s', server_status);
//	console.log('server_header: %s', server_header);
//	for await(const value of server_body){
//		console.log(value);
//		console.log('--------');
//	}
//	return ;
//}

//foo();

class local_http_error{
	public status_code: number;
	public message: string;
	public encoding?: BufferEncoding | undefined;

	public constructor(status_code: number, message: string, encoding?: BufferEncoding | undefined){
		this.status_code = status_code;
		this.message = message;
		if(encoding === undefined){
			return ;
		}
		this.encoding = encoding;
	}
}; // class local_http_error

function write_error_text(res: http.ServerResponse, error: local_http_error){
	const result_encoding: BufferEncoding = error.encoding ?? 'utf-8';
	const result_buffer = Buffer.from(error.message, result_encoding);

	res.writeHead(
		error.status_code,
		{
			'Content-Type': `text/plain; charset=${result_encoding}`
		}
	);
	res.write(result_buffer);
	res.end();
	return ;
}

function catch_local_http_error<Req extends http.IncomingMessage, Res extends http.ServerResponse>(
	handler: (req: Req, res: Res) => Promise<void>
): (req: Req, res: Res) => Promise<void>{
	return async (req: Req, res: Res): Promise<void> => {
		try{
			await handler(req, res);
			return ;
		}
		catch(err: unknown){
			if(err instanceof local_http_error){
				write_error_text(res, err);
				return ;
			}
			throw err;
		}
	};
}

interface request_options{
	protocol: 'http' | 'https',
	proxy_host: string,
	proxy_port: number,
	dest_host: string,
	dest_port: number | undefined
}; // interface request_options

function parse_request_options(url: string): [request_options, string]{
	// protocol/proxy_host:proxy_port/dest_host:dest_port/blah...
	const url_list = url.split('/');
	let iter = url_list[Symbol.iterator]();
	let current_yield = iter.next();

	while((!current_yield.done) && (current_yield.value === '')){
		current_yield = iter.next();
	}
	if(current_yield.done){
		throw new local_http_error(400, 'Missing proxy protocol, proxy host/port, destination host/port in the request url.');
	}
	const protocol_str: string = current_yield.value;
	if((protocol_str !== 'http') && (protocol_str !== 'https')){
		throw new local_http_error(400, `Illegal protocol name '${protocol_str}'.`);
	}
	const protocol = protocol_str;
	current_yield = iter.next();

	while((!current_yield.done) && (current_yield.value === '')){
		current_yield = iter.next();
	}
	if(current_yield.done){
		throw new local_http_error(400, 'Missing proxy host/port, destination host/port in the request url.');
	}
	const proxy_address = current_yield.value;
	const [proxy_host, proxy_port] = (() => {
		let url_obj: URL | undefined = undefined;
		try{
			url_obj = new URL(`foo://${proxy_address}`);
		}
		catch(err: unknown){
			if(err instanceof TypeError){
				throw new local_http_error(400, `Invalid proxy address specified: ${proxy_address}.`);
			}
			throw new local_http_error(500, 'Unknown error happened.');
		}
		if(url_obj.port === ''){
			throw new local_http_error(400, 'Missing proxy port in the request url.');
		}
		return [url_obj.hostname, Number(url_obj.port)];
	})();
	current_yield = iter.next();

	while((!current_yield.done) && (current_yield.value === '')){
		current_yield = iter.next();
	}
	if(current_yield.done){
		throw new local_http_error(400, 'Missing destination host/port in the request url.');
	}
	const dest_address = current_yield.value;
	const [dest_host, dest_port] = (() => {
		let url_obj: URL | undefined = undefined;
		try{
			url_obj = new URL(`foo://${dest_address}`);
		}
		catch(err: unknown){
			if(err instanceof TypeError){
				throw new local_http_error(400, `Invalid destination address specified: ${dest_address}.`);
			}
			throw new local_http_error(500, 'Unknown error happened.');
		}
		const port_num: number | undefined = (url_obj.port === '')? undefined: Number(url_obj.port);
		return [url_obj.hostname, port_num];
	})();
	current_yield = iter.next();

	const remaining_url = (() => {
		let ret = '';
		while(!current_yield.done){
			ret += '/' + current_yield.value;
			current_yield = iter.next();
		}
		return ret;
	})();
	return [
		{
			protocol: protocol,
			proxy_host: proxy_host,
			proxy_port: proxy_port,
			dest_host: dest_host,
			dest_port: dest_port
		},
		remaining_url
	];
}

interface cli_options{
	bind_port: number
}; // interface cli_options

function parse_cli_options(argv?: string[]): cli_options{
	let input_argv: string[] | undefined = undefined;
	if(argv === undefined){
		if(process.argv.length > 2){
			input_argv = process.argv.slice(2);
		}
	}
	else{
		input_argv = argv;
	}
	if(input_argv === undefined){
		return {
			bind_port: 12345
		};
	}

	let temp_url_obj: URL | undefined = undefined;
	try{
		temp_url_obj = new URL(`foo://bar.baz:${input_argv[0]}`);
	}
	catch(err: unknown){
		throw new Error(`Invalid bind port value ${input_argv[0]} specified.`);
	}
	return {
		bind_port: Number(temp_url_obj.port)
	};
}

const options = parse_cli_options();

let server = http.createServer(catch_local_http_error(async (
	req: http.IncomingMessage,
	res: http.ServerResponse & { req: http.IncomingMessage }
) => {
	if(req.url === undefined){
		// Should this be client error or server error?
		throw new local_http_error(400, 'Url is missing in the request.');
	}
	if(req.method === undefined){
		throw new local_http_error(400, 'Method is missing in the request');
	}
	const req_method = req.method;

	const [request_options, remaining_url] = parse_request_options(req.url);
	if(request_options.protocol === 'http'){
		throw new local_http_error(501, 'Accessing destination address through http proxy is not implemented yet.');
	}

	// If we directly copy client's incoming http headers to upstream's
	// outgoing http headers and copy upstream's incoming http headers back to
	// client's outgoing http headers, it's probably preferrable that we should
	// act as a transparent proxy.
	// Our current design does not seem to suit the description above now.
	// However, we currently don't have a better solution since adjusting
	// headers one by one needs a lot of work (maybe), and refactor our design
	// to make it a transparent proxy doesn't seem to suit our need.
	// Perhaps for the main case that to be used for pacman, the problem might
	// not be huge as such.
	// Note: `IncomingHttpHeaders` type are compatible with
	// `OutgoingHttpHeaders` type, but not vice versa.
	const req_headers: http.IncomingHttpHeaders = req.headers;
	//const upstream_req_headers: http.OutgoingHttpHeaders = req_headers;
	const upstream_req_headers = ((): http.OutgoingHttpHeaders => {
		let ret: http.OutgoingHttpHeaders = {};
		for(const [k, v] of Object.entries(req_headers)){
			// .. But of course we need to remove the `host` header from req
			// headers
			if(k === 'host'){
				continue;
			}
			ret[k] = v;
		}
		return ret;
	})();

	// Set up `readable_data` instance during the first invocation of this
	// coroutine, so that we won't miss any `data` events on `req`
	// Note: if there's no body for `req`, `body_reader` will simply become an
	// `AsyncGenerator` that won't yield anything, not instead an `undefined`.
	let body_reader = new utils_.readable_data(req);	// TODO: handle error

	let {server_status, server_header, server_body} = await utils_.https_proxy_read({
		body: utils_.readable_contents(body_reader),
		headers: upstream_req_headers,
		host: request_options.dest_host,
		method: req_method,
		path: remaining_url,
		proxy_host: request_options.proxy_host,
		proxy_port: request_options.proxy_port,
		port: request_options.dest_port
	});

	const res_headers: http.OutgoingHttpHeaders = server_header;
	const server_status_message = server_status.message;
	if(server_status.message === server_status_message){
		res.writeHead(server_status.code, res_headers);
	}
	else{
		res.writeHead(server_status.code, server_status_message, res_headers);
	}
	// TODO: handle error
	let res_writer = new utils_.writeable_writer(res);
	for await(let data of server_body){
		await res_writer.write(data);
	}
	res.end();
}));

server.listen(options.bind_port);