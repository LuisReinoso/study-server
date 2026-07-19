import { createAuthMiddleware } from "./auth";

function mockReqRes(authorizationHeader?: string) {
  const json = jest.fn();
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = json;

  const req: any = {
    header: (name: string) => (name.toLowerCase() === "authorization" ? authorizationHeader : undefined),
  };

  const next = jest.fn();
  return { req, res, next, status: res.status, json };
}

describe("createAuthMiddleware", () => {
  it("is a no-op (auth disabled) when token is undefined", () => {
    const middleware = createAuthMiddleware(undefined);
    const { req, res, next, status, json } = mockReqRes();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it("is a no-op (auth disabled) when token is an empty string", () => {
    const middleware = createAuthMiddleware("");
    const { req, res, next, status } = mockReqRes();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it("returns 401 { error: 'unauthorized' } when no Authorization header is sent", () => {
    const middleware = createAuthMiddleware("secret-token");
    const { req, res, next, status, json } = mockReqRes(undefined);

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "unauthorized" });
  });

  it("returns 401 { error: 'unauthorized' } when the wrong token is sent", () => {
    const middleware = createAuthMiddleware("secret-token");
    const { req, res, next, status, json } = mockReqRes("Bearer wrong-token");

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "unauthorized" });
  });

  it("returns 401 when the header is missing the Bearer prefix", () => {
    const middleware = createAuthMiddleware("secret-token");
    const { req, res, next, status } = mockReqRes("secret-token");

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it("calls next() (200 path) when the Bearer token matches exactly", () => {
    const middleware = createAuthMiddleware("secret-token");
    const { req, res, next, status, json } = mockReqRes("Bearer secret-token");

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });
});
