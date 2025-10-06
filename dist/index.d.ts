declare module "@actions/core" {
    function getInput(name: string, options?: {
        required?: boolean;
    }): string;
    function setFailed(message: string | Error): void;
    function info(message: string): void;
    function warning(message: string): void;
    function setOutput(name: string, value: string): void;
}
export {};
