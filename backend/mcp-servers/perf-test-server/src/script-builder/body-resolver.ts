export interface EndpointSpec {
  method: string;
  path: string;
  requiredBodyFields?: string[];
  bodyAllFields?: string[];
  bodyFieldExamples?: Record<string, unknown>;
}

/**
 * Build the runtime body expression and comment for a POST/PUT/PATCH endpoint.
 * Implements the Option C hybrid logic from the original code.
 */
export function buildBodyExpression(
  ep: EndpointSpec,
  hasTestData: boolean
): { bodyExpr: string; comment: string } {
  const pathSegments = ep.path.split("/").filter(Boolean);
  const lastSegment =
    pathSegments[pathSegments.length - 1]?.replace(/[{}]/g, "") || "default";
  const lastNonParamSegment =
    [...pathSegments]
      .reverse()
      .find((s) => !s.startsWith("{"))
      ?.replace(/[{}]/g, "") || lastSegment;
  const methodPathKey = `body_${ep.method}_${ep.path}`;

  // Build baseBody: required fields that have an OpenAPI example
  const requiredFields: string[] = ep.requiredBodyFields || [];
  const allFields: string[] = ep.bodyAllFields || [];
  const examples: Record<string, unknown> = ep.bodyFieldExamples || {};
  const baseBody: Record<string, unknown> = {};
  for (const field of requiredFields) {
    if (field in examples) baseBody[field] = examples[field];
  }
  const baseBodyJson = JSON.stringify(baseBody);

  // Runtime body expression — Option C hybrid
  let bodyRuntimeExpr: string;
  if (hasTestData && allFields.length > 0) {
    // Prefer explicit body_* key; fall back to OpenAPI-filtered flat row fields
    const allFieldsJson = JSON.stringify(allFields);
    bodyRuntimeExpr = `(function() {
        var _explicit = row[${JSON.stringify(methodPathKey)}] || row['body_${lastNonParamSegment}'] || row['body_${lastSegment}'] || null;
        if (_explicit) return _explicit;
        var _fields = ${allFieldsJson};
        var _r = {};
        for (var _i = 0; _i < _fields.length; _i++) { var _f = _fields[_i]; if (row[_f] !== undefined) _r[_f] = row[_f]; }
        return _r;
      })()`;
  } else if (hasTestData) {
    // No OpenAPI fields known — use body_* key lookup only
    bodyRuntimeExpr = `(row[${JSON.stringify(methodPathKey)}] || row['body_${lastNonParamSegment}'] || row['body_${lastSegment}'] || {})`;
  } else {
    bodyRuntimeExpr = "{}";
  }

  const bodyExpr = `JSON.stringify(Object.assign({}, ${baseBodyJson}, ${bodyRuntimeExpr}))`;
  const requiredFieldNames = requiredFields.join(", ") || "(none)";
  const allFieldNames = allFields.join(", ") || "(none from OpenAPI)";
  const comment = `required fields: ${requiredFieldNames} | all fields: ${allFieldNames}`;

  return { bodyExpr, comment };
}
