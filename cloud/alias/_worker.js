// A stable, short Pages address forwards to the current production Worker.
// Service bindings preserve the original request URL and session cookies.
export default {
  fetch(request, env) {
    return env.BACKEND.fetch(request);
  },
};
