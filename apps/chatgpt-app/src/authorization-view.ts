import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Box, Button, Card, Code, Container, Flex, Heading, Strong, Text, Theme } from "@radix-ui/themes";
import type { describeScopes } from "./oauth-scopes.ts";

export const AUTH_STYLES_PATH = "/assets/authorization.css";

export function paragraph(text: string): ReactNode {
  return h(Text, { key: text, as: "p", size: "2", color: "gray" }, text);
}

export function consentView(clientName: string, csrf: string, details: ReturnType<typeof describeScopes>): ReactNode {
  const groups = new Map<string, typeof details>();
  for (const detail of details) {
    const group = groups.get(detail.group) ?? [];
    group.push(detail);
    groups.set(detail.group, group);
  }
  return h(Flex, { direction: "column", gap: "5" },
    h(Text, { as: "p" }, h(Strong, null, clientName), " 请求使用 Harness X Harness。"),
    paragraph("接下来由 GitHub 验证你的身份。Harness 只会得到运行仓库和 Actions 工作流的控制凭据。"),
    paragraph("这些权限决定你的客户端能让 Harness 做什么。GitHub 会另外验证你和执行仓库里的操作。"),
    h(Heading, { as: "h2", size: "4" }, "请求的权限"),
    details.length === 0 ? paragraph("没有请求权限。") :
      [...groups].map(([group, scopes]) => h(Box, { key: group },
        h(Heading, { as: "h3", size: "3", mb: "3" }, group),
        h(Flex, { direction: "column", gap: "3" },
          scopes.map(({ scope, title, description }) => h(Card, { key: scope },
            h(Flex, { direction: "column", gap: "2" },
              h(Text, { weight: "medium" }, title),
              paragraph(description),
              h(Code, { size: "1" }, scope),
            ),
          )),
        ),
      )),
    h("form", { method: "post", action: "/authorize/consent" },
      h("input", { type: "hidden", name: "csrf", value: csrf }),
      h(Flex, { gap: "3", wrap: "wrap" },
        h(Button, { className: "px-allow", size: "3", highContrast: true, type: "submit", name: "decision", value: "allow" }, "用 GitHub 继续"),
        h(Button, { className: "px-cancel", size: "3", variant: "soft", color: "gray", type: "submit", name: "decision", value: "deny" }, "取消"),
      ),
    ),
  );
}

export function authorizationDocument(title: string, body: ReactNode): string {
  return "<!doctype html>" + renderToStaticMarkup(h("html", { lang: "zh" },
    h("head", null,
      h("meta", { charSet: "utf-8" }),
      h("meta", { name: "viewport", content: "width=device-width,initial-scale=1" }),
      h("title", null, title),
      h("link", { rel: "stylesheet", href: AUTH_STYLES_PATH }),
    ),
    h("body", null,
      h(Theme, { className: "pixel-auth", accentColor: "green", grayColor: "slate", radius: "none" },
        h(Container, { size: "2", px: "4", py: "8" },
          h("main", null,
            h(Heading, { as: "h1", size: "7", mb: "5" }, title),
            body,
          ),
        ),
      ),
    ),
  ));
}
