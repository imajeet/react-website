import { exists, is_object } from '../../helpers'
import { goto_action } from '../actions'
import { location_url } from '../../location'

export const RESULT_ACTION_PROPERTY = 'value'
export const ERROR_ACTION_PROPERTY = 'error'

// Asynchronous middleware (e.g. for HTTP Ajax calls).
//
// Takes effect only if the `dispatch`ed action has
// `promise` function and `events` (or `event`) property.
//
// `dispatch()` call will return a `Promise`.
//
export default function asynchronous_middleware(http_client, redux_event_naming, server, on_error, parseError = parse_error, get_history)
{
	return ({ dispatch, getState }) =>
	{
		// Can cancel previous actions of the same `type` (if configured).
		// E.g. for an AJAX autocomplete.
		const cancellable_promises = {}

		return next => action =>
		{
			let { promise, event, events, cancelPrevious, ...rest } = action

			// If the dispatched action doesn't have a `promise` function property then do nothing
			if (typeof promise !== 'function')
			{
				return next(action)
			}

			// Generate the three event names automatically based on a base event name
			if (!events && typeof event === 'string')
			{
				events = redux_event_naming(event)
			}

			// Validate `events` property
			if (!events || events.length !== 3)
			{
				throw new Error(`"events" property must be an array of 3 event names: e.g. ['pending', 'success', 'error']`)
			}

			// event names
			const [Request, Success, Failure] = events

			// dispatch the `pending` event to the Redux store
			dispatch({ ...rest, type: Request })

			// Run the asychronous action (e.g. an HTTP request)
			const promised = promise({ http: http_client, dispatch, getState })

			// Validate that `promise()` actually returned a `Promise`
			if (!promised || typeof promised.then !== 'function')
			{
				throw new Error(`"promise" function must return a Promise. Got:`, promised)
			}

			// Is the action promise cancellable
			const cancellable = !server && cancelPrevious && typeof promised.cancel === 'function'

			// Cancel previous action of the same `type` (if configured).
			// E.g. for an AJAX autocomplete.
			if (cancellable)
			{
				if (cancellable_promises[Request])
				{
					cancellable_promises[Request].cancel()
				}

				cancellable_promises[Request] = promised
			}

			// Returning the result like this,
			// because if returned the `promised.then()` chain directly
			// then it wouldn't get detected as an "Unhandled rejection"
			// in case of an error.
			return new Promise((resolve, reject) =>
			{
				// Don't `return` this promise
				// so that it detects it as an "Unhandled rejection"
				// in case of an error.
				promised.then
				(
					// If the Promise resolved
					// (e.g. an HTTP request succeeded)
					(result) =>
					{
						// The default `Promise` implementation has no `.finally()`
						if (cancellable)
						{
							delete cancellable_promises[Request]
						}

						// Dispatch the `success` event to the Redux store
						dispatch
						({
							...rest,
							type : Success,
							[RESULT_ACTION_PROPERTY] : result
						})

						// Returning the result like this,
						// because if returned the `promised.then()` chain directly
						// then it wouldn't get detected as an "Unhandled rejection"
						// in case of an error.
						resolve(result)

						// The Promise returned from `dispatch()` call
						// is resolved with the `promise` resolved value.
						return result
					},
					// if the Http request failed
					//
					// (Http status !== 20x
					//  or the Http response JSON object has an `error` field)
					(error) =>
					{
						// The default `Promise` implementation has no `.finally()`
						if (cancellable)
						{
							delete cancellable_promises[Request]
						}

						// Dispatch the `failure` event to the Redux store
						dispatch
						({
							...rest,
							type : Failure,
							[ERROR_ACTION_PROPERTY] : parseError(error)
						})

						// The Promise returned from `dispatch()` call
						// is rejected with this error.

						// Only checks `http` calls which are not part of `@preload()`
						// so that they don't get "error handled" twice
						// (doesn't affect anything, just a minor optimization).
						// Also only checks `http` calls on client side
						// because on server side `http` calls can be
						// either part of `@preload` of part of `initialize`
						// which are already "error handled".
						// On the client side though, an `http` call
						// may be performed via some user input,
						// so it needs this separate case "error handler".
						if (!server && on_error && !action.preloading)
						{
							const location = get_history().getCurrentLocation()

							// Report the error
							// (for example, redirect to a login page
							//  if a JWT "access token" expired)
							on_error(error,
							{
								path : location.pathname,
								url  : location_url(location),
								// Using `goto` instead of `redirect` here
								// because it's not part of `@preload()`
								// and is therefore part of some kind of an HTTP request
								// triggered by user input (e.g. form submission)
								// which means it is convenient to be able to
								// go "Back" to the page on which the error originated.
								redirect : to => dispatch(goto_action(to)),
								dispatch,
								getState,
								server
							})
						}

						// Returning the result (error) like this,
						// because if returned the `promised.then()` chain directly
						// then it wouldn't get detected as an "Unhandled rejection"
						// in case of an error.
						reject(error)

						throw error
					}
				)
			})
		}
	}
}

// Transform Javascript `Error` instance into a plain JSON object
// because the meaning of the `error` action is different
// from what `Error` class is: it should only carry info like
// `status`, `message` and possible other values (e.g. `code`),
// without any stack traces, line numbers, etc.
// I.e. the `error` action should be a plain javascript object,
// not an instance of an `Error` class, because it's Redux (stateless).
//
// Parses a `superagent` `Error` instance
// into a plain JSON object for storing it in Redux state.
// In case of an `application/json` HTTP response
// the `error` instance ha `.data` JSON object property
// which carries the `application/json` HTTP response data.
//
function parse_error(error)
{
	// Copies JSON HTTP response entirely
	const error_data = is_object(error.data) ? error.data : {}

	// Sets HTTP response `status` code
	// if `status` property wasn't present in JSON HTTP response.
	if (!exists(error_data.status))
	{
		error_data.status = error.status
	}

	// Copies `message` from `Error` instance
	// if `message` property wasn't present in JSON HTTP response.
	if (!exists(error_data.message))
	{
		error_data.message = error.message
	}

	return error_data
}