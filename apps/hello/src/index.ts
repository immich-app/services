export default {
  // eslint-disable-next-line @typescript-eslint/require-await
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Handle different routes
    switch (url.pathname) {
      case '/': {
        return Response.json(
          {
            message: 'Hello from Immich Worker API!',
            timestamp: new Date().toISOString(),
            path: url.pathname,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
          },
        );
      }

      case '/health': {
        return Response.json(
          {
            status: 'healthy',
            timestamp: new Date().toISOString(),
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
          },
        );
      }

      case '/api/greet': {
        const name = url.searchParams.get('name') || 'World';
        return Response.json(
          {
            greeting: `Hello, ${name}!`,
            timestamp: new Date().toISOString(),
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
          },
        );
      }

      default: {
        return Response.json(
          {
            error: 'Not Found',
            path: url.pathname,
          },
          {
            status: 404,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
          },
        );
      }
    }
  },
};
