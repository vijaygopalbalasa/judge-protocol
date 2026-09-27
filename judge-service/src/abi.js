// Minimal ABIs: the ACP surface we read + the JudgeEvaluator surface we write.

export const acpAbi = [
  {
    name: "getJob", type: "function", stateMutability: "view",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [{
      type: "tuple", components: [
        { name: "id", type: "uint256" },
        { name: "client", type: "address" },
        { name: "provider", type: "address" },
        { name: "evaluator", type: "address" },
        { name: "description", type: "string" },
        { name: "budget", type: "uint256" },
        { name: "expiredAt", type: "uint256" },
        { name: "status", type: "uint8" },
        { name: "hook", type: "address" },
      ],
    }],
  },
  {
    name: "JobSubmitted", type: "event", anonymous: false,
    inputs: [
      { indexed: true, name: "jobId", type: "uint256" },
      { indexed: true, name: "provider", type: "address" },
      { indexed: false, name: "deliverable", type: "bytes32" },
    ],
  },
];

export const judgeAbi = [
  {
    name: "submitVerdict", type: "function", stateMutability: "nonpayable",
    inputs: [
      {
        name: "v", type: "tuple", components: [
          { name: "jobId", type: "uint256" },
          { name: "criteriaHash", type: "bytes32" },
          { name: "deliverable", type: "bytes32" },
          { name: "score", type: "uint8" },
          { name: "threshold", type: "uint8" },
          { name: "pass", type: "bool" },
          { name: "evidenceHash", type: "bytes32" },
          { name: "timestamp", type: "uint64" },
        ],
      },
      { name: "sig", type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "relay", type: "function", stateMutability: "nonpayable",
    inputs: [
      {
        name: "v", type: "tuple", components: [
          { name: "jobId", type: "uint256" },
          { name: "criteriaHash", type: "bytes32" },
          { name: "deliverable", type: "bytes32" },
          { name: "score", type: "uint8" },
          { name: "threshold", type: "uint8" },
          { name: "pass", type: "bool" },
          { name: "evidenceHash", type: "bytes32" },
          { name: "timestamp", type: "uint64" },
        ],
      },
      { name: "sig", type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "registerCriteria", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "criteriaHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    name: "jobCriteria", type: "function", stateMutability: "view",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    name: "isSigner", type: "function", stateMutability: "view",
    inputs: [{ name: "signer", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "getVerdict", type: "function", stateMutability: "view",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [{
      type: "tuple", components: [
        { name: "jobId", type: "uint256" },
        { name: "criteriaHash", type: "bytes32" },
        { name: "deliverable", type: "bytes32" },
        { name: "score", type: "uint8" },
        { name: "threshold", type: "uint8" },
        { name: "pass", type: "bool" },
        { name: "evidenceHash", type: "bytes32" },
        { name: "timestamp", type: "uint64" },
      ],
    }],
  },
  {
    name: "withdraw", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
];

export const STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];
