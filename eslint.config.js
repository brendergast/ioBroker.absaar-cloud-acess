import globals from "globals";
import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2021,
        // ioBroker Skript-Umgebung
        getState: "readonly",
        setState: "readonly",
        setStateAsync: "readonly",
        createState: "readonly",
        schedule: "readonly",
        log: "readonly"
      }
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-undef": "error",
      "semi": ["error", "always"],
      "quotes": ["error", "single"],
      "indent": ["error", 4]
    }
  }
];
